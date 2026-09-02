import {
  GamevaultGameTypeEnum,
  type GamevaultGameTypeEnum as GameType,
} from "@/api/models/GamevaultGame";

export type InstallViewMode = "portable" | "setup" | "undetected";

/**
 * The backend's GamevaultGameTypeEnum has no "Linux setup" value - only
 * linux_portable/linux_software - so a native Linux installer (e.g. a GOG
 * mojosetup .sh script) can never be auto-detected as needing one run. The
 * "setup" install flow itself doesn't actually care what OS the label
 * implies: it just lists executable-looking files (.exe/.msi/.sh/.run/...)
 * and spawns whichever one is picked, which already runs a .sh correctly
 * on Linux. LINUX_SETUP exists purely so the force-install-type picker can
 * offer an honestly-labeled option that resolves to that same "setup" mode
 * - it's never sent to or recognized by the backend, only used in this
 * session's local install-flow state.
 */
export const LINUX_SETUP = "LINUX_SETUP" as const;
export type ForcedInstallType = GameType | typeof LINUX_SETUP;

export type InstallCardState = {
  mode: InstallViewMode;
  forcedType: ForcedInstallType;
  installerOptions: string[];
  selectedInstaller: string;
  loadingInstallers: boolean;
  installerLoadError?: string;
};

export const FORCE_INSTALL_TYPES: { label: string; value: ForcedInstallType }[] = [
  { label: "Windows Setup", value: GamevaultGameTypeEnum.windows_setup },
  { label: "Windows Portable", value: GamevaultGameTypeEnum.windows_portable },
  { label: "Linux Setup", value: LINUX_SETUP },
  { label: "Linux Portable", value: GamevaultGameTypeEnum.linux_portable },
];

export function formatGameTypeLabel(gameType?: string) {
  if (!gameType) return "Undetectable";
  return gameType
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function resolveInstallMode(gameType?: string): InstallViewMode {
  if (gameType === GamevaultGameTypeEnum.windows_setup || gameType === LINUX_SETUP) {
    return "setup";
  }

  if (
    gameType === GamevaultGameTypeEnum.windows_portable ||
    gameType === GamevaultGameTypeEnum.linux_portable ||
    gameType === GamevaultGameTypeEnum.windows_software ||
    gameType === GamevaultGameTypeEnum.linux_software
  ) {
    return "portable";
  }

  return "undetected";
}

export function normalizeRelativePath(value?: string) {
  return (value || "").replace(/\\/g, "/").toLowerCase();
}

export function pickPreferredInstaller(options: string[], preferred?: string) {
  if (!options.length) return "";
  if (!preferred) return options[0];

  const normalizedPreferred = normalizeRelativePath(preferred);
  const exactMatch = options.find(
    (option) => normalizeRelativePath(option) === normalizedPreferred,
  );
  if (exactMatch) return exactMatch;

  const suffixMatch = options.find((option) =>
    normalizeRelativePath(option).endsWith(normalizedPreferred),
  );
  return suffixMatch || options[0];
}
