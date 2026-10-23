/** Flip only after the published installer signatures have been verified. */
export const INSTALLER_SIGNED = false;
export const CODE_LOCATION = "shown in the SC2 Tools window on your PC";
export const smartScreenNote = INSTALLER_SIGNED
  ? "The installer is code-signed. Check its publisher in Windows Properties → Digital Signatures."
  : "The installer isn't code-signed yet, so Windows SmartScreen may warn you. Choose More info → Run anyway.";

export function sourceInstallSnippet(os: string): string {
  const windows = os === "windows" || os === "unknown";
  const python = windows ? "py" : "python3";
  const activate = windows ? ".venv\\Scripts\\activate" : "source .venv/bin/activate";
  return `git clone https://github.com/ReSpOnSeSC2/sc2tools.git
cd sc2tools/apps/agent
${python} -m venv .venv
${activate}
${python} -m pip install -r requirements.txt
${python} -m sc2tools_agent`;
}
