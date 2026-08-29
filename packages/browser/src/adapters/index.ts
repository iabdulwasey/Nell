/**
 * @nell/browser/adapters
 *
 * The implementations that actually drive a browser. Separated from the package
 * root because they carry a browser binary, and the policy engine, the view
 * layer and the eval harness all need the vocabulary without the driver.
 */

export { LocalBrowserProvider, type FileResolver, type LocalBrowserOptions } from "./local.js";

export { LocalMachineHost, type LocalMachineOptions } from "./local-machine.js";

export {
  playwrightKey,
  runComputerActions,
  screenshotOf,
  type CaptureOptions,
  type ComputerRunResult,
} from "./computer-exec.js";
