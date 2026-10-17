# Actual widget example harness

Run from `apps/web`:

```powershell
node scripts/widget-examples/server.mjs
```

Open `http://localhost:4317/?widget=opponent`. Choose any of the 31 widgets in the dropdown or set its catalog ID in the URL. The `#capture` stage is 1400 × 900 pixels at the top of the page. Controls sit below that stage.

This development tool imports the real widget components and their production artwork. Vite aliases only their data/audio hooks to deterministic synthetic fixtures. No real account, overlay token, chat connection, or API is used. The fixed test token is a local fixture label. Fetch and WebSocket are blocked/replaced locally; Vite HMR is disabled. Each selection reloads the page so entry state is reproducible.

Capture with a 1400 × 1000 browser viewport, then save the stage rectangle at
`x: 0, y: 0, width: 1400, height: 900` as `<widget-id>.jpg` into a temporary
directory. Verify the viewport after creating a tab. Wait for the widget to
render before capturing. For Chat poll, wait until its scripted demo reaches
22 votes so the image includes populated bars. The randomizer shows one
settled wheel reveal; the scene excludes optional video/b-roll.

Optimize all captures from `apps/web`:

```powershell
node scripts/pack-widget-examples.mjs C:/SC2TOOLS/.tmp/widget-examples-captures
```

This writes the 31 WebP images used by the public learning page to
`public/images/widget-examples/`. The learning catalog tests verify that
every supported widget has a 1400 × 900 image. Review a contact sheet and the
full-size examples whenever the widget designs change.

Images are captured through the computer-use browser and exported separately.
This directory is not an App Router route and is not shipped in the public
website. Only the optimized images reach the learning page; opening a guide
does not load the live widget code or its connections.
