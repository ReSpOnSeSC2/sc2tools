import { afterEach, expect, it } from "vitest";
import { focusableInside } from "./focusScopes";
afterEach(() => { document.body.innerHTML = ""; });
it("exposes only the first summary of closed details and preserves visibility/disabled guards", () => {
  const root = document.createElement("div"); document.body.append(root);
  root.innerHTML = `<details><summary id="summary">More</summary><button>Closed body</button><summary>Extra summary</summary></details>
    <details open><summary id="open-summary">Expanded</summary><button id="expanded">Visible body</button></details>
    <fieldset disabled><button>Disabled</button></fieldset><div inert><button>Inert</button></div>
    <div hidden><button>Hidden</button></div><div aria-hidden="true"><button>Aria hidden</button></div>
    <div style="display:none"><button>CSS hidden</button></div><button data-focus-trap-skip>Skipped</button><button tabindex="-1">Negative</button>`;
  expect(focusableInside(root).map(node => node.id)).toEqual(["summary", "open-summary", "expanded"]);
});
