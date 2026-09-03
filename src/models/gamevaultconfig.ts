export interface GameVaultConfig {
  gameid?: number;
  versionid?: number;
  gametype?: string;
  downloadfinished: boolean;
  extractionfinished: boolean;
  installationfinished?: boolean;
  downloadprogress: string;
  launchexecutable?: string;
  launchparameters?: string;
  launchasadmin?: boolean;
  /** Stable per-installation UUID v4, sent as X-Installation-Id when syncing saves. */
  installationid?: string;
}
