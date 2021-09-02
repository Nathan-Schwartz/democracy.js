/**
 * democracy.js
 * Copyright (c) 2016 - 2021, GoldFire Studios, Inc.
 * http://goldfirestudios.com
 */

import shortid from 'shortid';
import { createSocket, Socket } from 'dgram';
import { EventEmitter } from  'events';
import { StringDecoder } from  'string_decoder';

import {
  NodeAddress,
  NodeId,
  NodeState,
  NodeInfo,
  NodeInfoMap,
  NodeAddressTuple,
  DemocracyOptions,
  DemocracyDefaultedOptions,
  SendExtra
} from './types';

// Create the string decoder.
const decoder = new StringDecoder('utf8');


// TODO: write a "stop" method
// TODO: make sure new higher weight nodes are elected upon joining the cluster
// - this might make things more brittle if a node keeps dropping
// TODO: setup typescript linting
// TODO: setup linting script
// TODO: setup linting + typing CI


/**
 * Setup the base Democracy class that handles all of the methods.
 */
class Democracy extends EventEmitter {
  private _nodes: NodeInfoMap;
  private _id: NodeId;
  private _weight: number;
  private _state: NodeState;
  private _chunks: Object; // TODO: specify
  private _hadElection: boolean

  options: DemocracyDefaultedOptions;
  socket: Socket;

  /**
   * Initialize a new democracy with the given options.
   * @param  {DemocracyOptions} options User-defined options.
   */
  constructor(options: DemocracyOptions = {}) {
    super();

    this._nodes = {};
    this._chunks = {};
    this._hadElection = false;

    // Remove the source from the peers.
    const sourceIndex = options.peers.indexOf(options.source);
    if (sourceIndex >= 0) {
      options.peers.splice(sourceIndex, 1);
    }

    // Merge the passed options with the defaults.
    this.options = {
      interval: options.interval || 1000,
      timeout: options.timeout || 3000,
      maxPacketSize: options.maxPacketSize || 508,
      source: this._parseAddress(options.source || '0.0.0.0:12345'),
      peers: (options.peers || []).map(a => this._parseAddress(a)),
      weight: options.weight || Math.random() * Date.now(),
      id: options.id || shortid.generate(),
      channels: options.channels || [],
    };


    // Generate the details about this node to be sent between nodes.
    this._id = this.options.id;
    this._weight = this.options.weight;
    this._state = 'citizen';

    // Setup the UDP socket to listen on.
    this.socket = createSocket({type: 'udp4', reuseAddr: true});

    this.start();
  }

  private _parseAddress(address: NodeAddress): NodeAddressTuple {
    const parts: Array<string> = address.split(':');
    return [parts[0], Number(parts[1])];
  }

  /**
   * Start the democratic process by binding to the UDP port and holding the first election.
   * @return {Democracy}
   */
  start(): this {
    // Bind to the UDP port and begin listeneing for hello, etc messages.
    this.socket.bind(this.options.source[1], this.options.source[0], () => {
      // Listen for messages on this port.
      this.socket.on('message', (msg) => {
        this.processEvent(msg);
      });

      // Start sending 'hello' messages to the other nodes.
      this.hello();
    });

    // Run an election after two intervals if we still don't have a leader.
    setTimeout(() => {
      // Check if we have a leader.
      let haveLeader = false;
      Object.keys(this._nodes).forEach((id) => {
        if (this._nodes[id].state === 'leader') {
          haveLeader = true;
        }
      });

      if (!haveLeader && this._state !== 'leader') {
        this.holdElections();
      }
    }, this.options.interval * 2);

    return this;
  }

  /**
   * Run the `hello` interval to send out the heartbeats.
   * @return {Democracy}
   */
  hello(): this {
    // Send a hello message and then check the other nodes.
    const sendHello = () => {
      this.send('hello');
      this.check();
    };

    // Schedule hello messages on the specified interval.
    setInterval(sendHello, this.options.interval);

    // Immediately send the first hello message.
    sendHello();

    return this;
  }

  /**
   * Send a message to the other peers.
   * @param  {String} event 'hello', 'vote', etc.
   * @param  {Object} extra Other data to send.
   * @param  {NodeId} Optionally specify a specific recipient by node id
   * @return {Democracy}
   */
  send(event: string, extra?: SendExtra, id?: NodeId): this {
    type Payload = {
      event: string,
      id: NodeId,
      source: NodeAddress
      candidate?: string,
      weight?: number,
      state?: NodeState,
      channels?: Array<string>,
      extra?: SendExtra
    }
    const data: Payload = {
      event,
      id: this._id,
      source: `${this.options.source[0]}:${this.options.source[1]}`
    };

    if (event === 'vote') {
      data.candidate = extra.candidate;
    } else {
      data.weight = this._weight;
      data.state = this._state;
      data.channels = this.options.channels;

      // Handle custom messaging between nodes.
      if (extra) {
        data.extra = extra;
      }
    }

    // Adjust the max size by the max size of the chunk wrapper data.
    const maxSize = this.options.maxPacketSize;
    const chunkSize = maxSize - 52;

    // Check if the packet needs to be chunked.
    const str = JSON.stringify(data);
    let chunks = [];
    if (str.length > maxSize) {
      const count = Math.ceil(str.length / chunkSize);
      const packetId = shortid.generate();

      for (let i = 0; i < count; i += 1) {
        chunks.push(JSON.stringify({
          chunk: str.substr(i * chunkSize, chunkSize),
          id: packetId,
          c: count,
          i,
        }));
      }
    } else {
      chunks.push(str);
    }

    // Data must be sent as a Buffer over the UDP socket.
    chunks = chunks.map(chunk => Buffer.from(chunk));

    // Loop through each connect node and send the packet over.
    for (let x = 0; x < chunks.length; x += 1) {
      for (let i = 0; i < this.options.peers.length; i += 1) {
        if (!id || this._nodes[id].source === `${this.options.peers[i][0]}:${this.options.peers[i][1]}`) {
          this.socket.send(chunks[x], 0, chunks[x].length, this.options.peers[i][1], this.options.peers[i][0]);
        }
      }
    }

    return this;
  }

  /**
   * After sending a `hello`, check if any of the other nodes are down.
   * @return {Democracy}
   */
  check(): this {
    Object.keys(this._nodes).forEach((id) => {
      if (this._nodes[id] && this._nodes[id].last + this.options.timeout < Date.now()) {
        // Increment the vote count.
        if (this._nodes[id].voters.indexOf(this._id) < 0) {
          this._nodes[id].voters.push(this._id);

          // Send the vote to the other peers that this one is down.
          this.send('vote', {candidate: id});
          this.checkBallots(id);
        }
      }
    });

    return this;
  }

  /**
   * Subscribe to a channel to listen for events from other nodes.
   * @param  {String} channel Channel name (can't be 'hello', 'vote', 'leader', or 'subscribe').
   * @return {Democracy}
   */
  // TODO: use channel type instead?
  subscribe(channel: string): this {
    // Add the channel to this node.
    this.options.channels.push(channel);

    // Broadcast to the other nodes that this one has subscribed.
    this.send('subscribe', {channel});

    return this;
  }

  /**
   * Publish a message to any nodes that are subscribed to the passed channel.
   * @param  {String} channel Channel to publish to.
   * @param  {Mixed} msg     Data to send.
   * @return {Democracy}
   */
  publish(channel: string, msg: any): this {
    // Loop through all nodes and send the message to ones that are subscribed.
    const ids = Object.keys(this._nodes);
    for (let i = 0; i < ids.length; i += 1) {
      const id = ids[i];
      if (this._nodes[id] && this._nodes[id].channels.includes(channel)) {
        this.send(channel, msg, id);
      }
    }

    return this;
  }

  /**
   * Add a new node's data to the internal node list
   * @param {data} data Node data to setup.
   * @return {Democracy}
   */
  private _addNodeToList(data: NodeInfo): this {
    // Add the node to the list.
    this._nodes[data.id] = {
      id: data.id,
      source: data.source,
      weight: data.weight,
      state: data.state,
      last: Date.now(),
      voters: [],
      channels: data.channels || [],
    };

    // Add this to the peers list.
    const source = this._parseAddress(data.source);
    const index = this.options.peers.findIndex(p => p[0] === source[0] && p[1] === source[1]);
    if (index < 0) {
      this.options.peers.push(source);
    }

    // Emit that this node has been added.
    this.emit('added', this._nodes[data.id]);

    return this;
  }

  /**
   * Process events that are received over the network.
   * @param  {Object} msg Data received.
   * @return {Democracy}
   */
  // TODO: write types for this
  processEvent(msg): this {
    const data = this.decodeMsg(msg);

    // TODO: add more explicit docs
    // Check if this is a chunk and put in the store.
    if (data && data.chunk && data.id) {
      // Add the chunk to the buffer.
      this._chunks[data.id] = this._chunks[data.id] || [];
      this._chunks[data.id].push(data);

      // If the buffer is full, combine and process.
      if (this._chunks[data.id].length === data.c) {
        // Sort the chunks by index.
        this._chunks[data.id].sort((a, b) => {
          if (a.i < b.i) {
            return -1;
          }
          if (a.i > b.i) {
            return 1;
          }

          return 0;
        });

        // Merge the data into a single string.
        const newData = this._chunks[data.id].reduce((acc, val) => acc + val.chunk, '');
        delete this._chunks[data.id];

        // Process the data as a buffer.
        this.processEvent(Buffer.from(newData));
      }

      return this;
    }

    // Noop if empty payload or we sent the message
    if (!data || data.id === this._id) {
      return this;
    }

    // No longer mark this node as removed.
    if (this._nodes[data.id] && this._nodes[data.id].disconnected) {
      clearTimeout(this._nodes[data.id].disconnected);
      delete this._nodes[data.id].disconnected;
    }

    // Process the different available events.
    if (data.event === 'hello') {
      // Create a new node if we don't already know about this one.
      if (!this._nodes[data.id]) {
        this._addNodeToList(data);
      } else {
        const revived = this._nodes[data.id].state === 'removed' && data.state !== 'removed';
        this._nodes[data.id].last = Date.now();
        this._nodes[data.id].state = data.state;
        this._nodes[data.id].weight = data.weight;

        if (revived) {
          this.emit('added', this._nodes[data.id]);
        }
      }

      // Reset the voters since we've now seen this node again.
      this._nodes[data.id].voters = [];

      // If we are both leaders, hold a runoff to determine the winner...hanging chads and all.
      if (this._state === 'leader' && data.state === 'leader') {
        this.holdElections();
      }

      // If we now have no leader, hold a new election.
      if (this._hadElection && !this.leader()) {
        this.holdElections();
      }

      // We have had an election somewhere if we have a leader.
      if (this.leader()) {
        this._hadElection = true;
      }
    } else if (data.event === 'vote') {
      if (this._nodes[data.candidate] && this._nodes[data.candidate].voters.indexOf(data.id) < 0) {
        // Tally this vote.
        this._nodes[data.candidate].voters.push(data.id);

        // Process the ballots to see if this node should be removed and a new leader selected.
        this.checkBallots(data.candidate);
      }
    } else if (data.event === 'leader') {
      if (!this._nodes[data.id]) {
        this._addNodeToList(data);
      } else {
        this._nodes[data.id].state = 'leader';
      }

      this.emit('leader', this._nodes[data.id]);
    } else if (data.event === 'subscribe') {
      if (!this._nodes[data.id]) {
        this._addNodeToList(data);
      } else {
        this._nodes[data.id].channels.push(data.extra.channel);
      }
    } else {
      // Handle custom messaging between nodes.
      this.emit(data.event, data.extra);
    }

    return this;
  }

  /**
   * Check if the decision to remove a node has been made unanimously by the active, healthy nodes.
   * @param  {String} candidate ID of the candidate to be removed.
   * @return {Democracy}
   */
  checkBallots(candidate): this {
    const node = this._nodes[candidate];
    const {state} = node;
    let numVoters = 0; // This is the number of votes we need to achieve consensus

    // Count how many nodes are healthy
    for (let i = 0; i < Object.keys(this._nodes).length; i += 1) {
      if (this._nodes[i] && !this._nodes[i].voters.length) {
        numVoters += 1;
      }
    }

    // If we have concensus, remove this node from the list.
    if (node.voters.length >= numVoters) {
      this.emit('removed', node);

      // Make sure we don't setup multiple timeouts.
      if (this._nodes[candidate].disconnected) {
        clearTimeout(this._nodes[candidate].disconnected);
      }

      // Mark the node as removed (to be removed later).
      this._nodes[candidate].state = 'removed';
      this._nodes[candidate].disconnected = setTimeout(() => {
        if (this._nodes[candidate].state !== 'removed') {
          return;
        }

        // Remove from the nodes/peers.
        const source = this._parseAddress(node.source);
        const index = this.options.peers.findIndex(p => p[0] === source[0] && p[1] === source[1]);
        if (index >= 0) {
          this.options.peers.splice(index, 1);
        }
        this._nodes[candidate] = null;
      }, 3600000);
    }

    if (state === 'leader') {
      this.holdElections();
    }

    return this;
  }

  /**
   * Hold an election for a new leader.
   * @return {Democracy}
   */
  holdElections(): this {
    const nodes = this.nodes();
    let highestWeight = 0;
    let newLeader;

    // Elect a new leader based on highest weight.
    // Each server should always elect the same leader (ignoring any network partitions)
    Object.keys(nodes).forEach((id) => {
      if (nodes[id] && nodes[id].weight > highestWeight && nodes[id].state !== 'removed') {
        highestWeight = nodes[id].weight;
        newLeader = id;
      }
    });

    // If we are currently the leader, but not the "new leader", we lose the runoff and resign.
    if (this._state === 'leader' && newLeader && newLeader !== this._id) {
      this.resign();
    }

    // Elect our new benevolent dictator for life...of process (unless a new node with higher weight joins) // TODO: is this true?
    if (newLeader === this._id) {
      if (this._state !== 'leader') {
        this._state = 'leader';
        nodes[newLeader].state = 'leader';
        this.emit('elected', nodes[newLeader]);
      }
      this.send('leader');
    } else if (newLeader) {
      this._nodes[newLeader].state = 'leader';
    }

    this._hadElection = true;

    return this;
  }

  /**
   * Resign as leader and fly into the sunset disgraced.
   * Calling this directly on the current leader will prompt a new election,
   * which could result in this same node becoming leader again (as is the way of the world).
   * @return {Democracy}
   */
  resign(): this {
    const nodes = this.nodes();

    if (this._state === 'leader') {
      this._state = 'citizen';
      this.emit('resigned', nodes[this._id]);
      this.send('hello');
    }

    return this;
  }

  /**
   * Get the list of current nodes, including this one.
   * @return {NodeInfoMap} All nodes.
   */
  nodes(): NodeInfoMap {
    const nodes = {};

    // Copy the nodes data to return.
    Object.keys(this._nodes).forEach((id) => {
      const node = this._nodes[id];

      if (node) {
        nodes[node.id] = {
          id: node.id,
          weight: node.weight,
          state: node.state,
          last: node.last,
          voters: node.voters,
          channels: node.channels,
        };
      }
    });

    // Add this server into the nodes list.
    nodes[this._id] = {
      id: this._id,
      weight: this._weight,
      state: this._state,
      channels: this.options.channels,
      voters: [], // TODO: this is a change but i don't think it is a breaking one
      source: this.options.source,
    };

    return nodes;
  }

  /**
   * Find our current fearless leader.
   * @return {NodeInfo} Current leader.
   */
  leader(): NodeInfo {
    const nodes = this.nodes();
    let leader = null;

    Object.keys(nodes).forEach((id) => {
      if (nodes[id] && nodes[id].state === 'leader') {
        leader = nodes[id];
      }
    });

    return leader;
  }

  /**
   * Check if the current server is the leader or not.
   * @return {Boolean} True if this is the leader.
   */
  isLeader(): boolean {
    const leader = this.leader();

    return leader ? this._id === leader.id : false;
  }

  /**
   * Safely decode a Buffer message received over UDP.
   * @param  {Buffer} msg Received data.
   * @return {any}     Parsed data.
   */
  decodeMsg(msg: Buffer): any {
    try {
      return JSON.parse(decoder.write(msg));
    } catch (e) {
      return null;
    }
  }
}

export default Democracy;
