export type NodeAddress = string; // Example: 0.0.0.0:12345
export type NodeId = string;
export type NodeState = 'removed' | 'citizen' | 'leader';

export type NodeInfo = {
  id: NodeId,
  weight: number,
  state: NodeState,
  channels: Array<string>,
  last: number, // ms timestamp
  voters: Array<NodeId>,
  source: NodeAddress,
  disconnected?: NodeJS.Timer,
}

export type NodeInfoMap = { [id: NodeId]: NodeInfo };

export type NodeAddressTuple = [ domain: string, port: number];

export type DemocracyOptions = {
  interval?: number,
  timeout?: number,
  maxPacketSize?: number,
  source?: NodeAddress,
  peers?: Array<NodeAddress>,
  weight?: number
  id?: NodeId,
  channels?: Array<string>,
}
export type DemocracyDefaultedOptions = {
  interval: number,
  timeout: number,
  maxPacketSize: number,
  source: NodeAddressTuple,
  peers: Array<NodeAddressTuple>,
  weight: number,
  id: NodeId,
  channels: Array<string>,
}

export type SendExtra = {
  candidate?: string,
  channel?: string,
  [key: string]: any,
};
