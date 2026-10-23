export const PAIRING_CODE_LOCATION = "shown in the SC2 Tools window on your PC";
export const normalizePairingCode = (value: string) => value.replace(/\D/g, "").slice(0, 6);

export interface PairedDevice {
  deviceId: string;
  hostname?: string;
  label?: string;
  agentOs?: string;
  agentOsRelease?: string;
  agentVersion?: string;
  createdAt: string;
  lastSeenAt: string | null;
}

export interface PairingInfo {
  sameNetwork: boolean;
  device: { deviceId: string; hostname: string; os: string; version: string };
}
