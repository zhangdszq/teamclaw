import appIconUrl from "../assets/app-icon.png";

/**
 * Resolve assistant avatar src.
 * "builtin:app-icon" maps to the bundled app icon asset.
 */
export function resolveAvatarSrc(avatar: string | undefined): string | undefined {
  if (!avatar) return undefined;
  if (avatar === "builtin:app-icon") return appIconUrl;
  return avatar;
}
