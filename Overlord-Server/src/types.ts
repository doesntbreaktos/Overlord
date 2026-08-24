export type ClientRole = "client" | "viewer";

export type EnrollmentStatus = "pending" | "approved" | "denied";

export type BuildTokenPayload = {
  v: 1;
  bid: string;
  uid: number | null;
  iat: number;
};

export type ClientInfo = {
  id: string;
  lastSeen: number;
  role: ClientRole;
  ws: any;
  lastPingSent?: number;
  lastPingNonce?: number;
  lastPongAt?: number;
  online?: boolean;
  hwid?: string;
  ip?: string;
  reportedPublicIp?: string;
  host?: string;
  os?: string;
  arch?: string;
  hostArch?: string;
  version?: string;
  user?: string;
  nickname?: string;
  customTag?: string;
  customTagNote?: string;
  monitors?: number;
  monitorInfo?: { width: number; height: number }[];
  country?: string;
  pingMs?: number;
  inMemory?: boolean;
  cpu?: string;
  gpu?: string;
  ram?: string;
  batteryPercent?: number | null;
  batteryCharging?: boolean | null;
  webcamAvailable?: boolean;
  webcamDevices?: { index: number; name: string; maxFps?: number }[];
  isAdmin?: boolean;
  elevation?: string;
  permissions?: Record<string, boolean>;
  enrollmentStatus?: EnrollmentStatus;
  buildTag?: string;
  builtByUserId?: number;
  publicKey?: string;
  keyFingerprint?: string;
  disconnectReason?: string;
  disconnectDetail?: string;
  groupId?: number | null;
  groupName?: string | null;
  groupColor?: string | null;
  notificationsMuted?: boolean;
  protocolVersion?: number;
  commandVersions?: Partial<Record<
    import("./generated/wire-contract").CommandType,
    import("./generated/wire-contract").CommandVersionRange
  >>;
};

export type ListFilters = {
  page: number;
  pageSize: number;
  search: string;
  sort: string;
  statusFilter?: string;
  osFilter?: string;
  countryFilter?: string;
  enrollmentFilter?: string;
  builtByUserId?: number;
  requireBuildOwner?: boolean;
  allowedClientIds?: string[];
  deniedClientIds?: string[];
  groupFilter?: string;
  webcamFilter?: string;
};

export type ListItem = Omit<ClientInfo, 'ws'> & {
  online: boolean;
  hasThumbnail: boolean;
  thumbnailVersion: number;
  suspiciousFlags: string[];
  denyReason?: string | null;
};

export type ListResult = {
  page: number;
  pageSize: number;
  total: number;
  online: number;
  items: ListItem[];
};
