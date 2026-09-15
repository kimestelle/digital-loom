# Room design system

The fabric carries color and complexity; the interface carries structure.
This system belongs to the main room at `/`. The original `/sky` has its own frozen stylesheet
and component copies; do not import room styles there.

## Where to change things

- `app/styles/tokens.css`: Absans/Necto Mono font aliases, base typography,
  shared motion curve and short interaction durations.
- `app/styles/room-tokens.css`: neutral UI palette, glass/grain, type sizes,
  common spacing, control dimensions, structural rules and motion roles.
  The light-theme adapter maps these onto existing authoring components once.
- `app/styles/room-controls.css`: shared native range styling with material
  and light variants. Keep WebKit and Firefox pseudo-element rules separate.
- `app/styles/room.css`: room geometry, cabinet/environment layout, component
  states, responsive transformations and accessibility alternatives.
- `app/styles/layout.css`: logo and navigation geometry.
- `app/styles/authoring-tokens.css`: compatibility theme for retained dark
  authoring overlays. It is not the room palette or the frozen original route.

`app/globals.css` is the ordered entry point. Tokens precede consumers; the room
range primitive follows the older shared controls. Do not add a second late
theme override to fix a component.

## Rules

- Absans names the object; Necto Mono labels actions and measurements. Existing
  8/9/10px dense labels are preserved here, not a recommendation for new prose.
- Room controls are square, neutral, and flat. The rounded, frosted-black logo
  and circular inspection lens are object-specific exceptions.
- Mounted logo/switch buttons share `--room-control-size` (44px). The environment
  rail starts directly at the logo's lower edge. Compact controls remain 32/36px
  on fine pointers; coarse-pointer targets retain their 44px minimums.
- Glass fill, backdrop filtering and sandpaper grain are independent. Text and
  control opacity must not be lowered to fade a panel. The environment rail
  fades its background; the cabinet does not. Mobile and accessibility surfaces
  use `--room-ui-solid`; keep their existing media rules.
- Material sliders intentionally use a 2px track/8px thumb; light sliders use
  a 1px track/9px outlined thumb. Change the variant tokens, not one browser's
  pseudo-element alone. Keep native input semantics and focus behavior.
- Dossier ink/lines are slightly stronger than archive/environment chrome.
  These are named theme variants, not three independently maintained palettes.
- Fixed transitions use `--ease-motion`; its JavaScript counterpart is
  `EASE_MOTION` in `lib/ui/motion.ts`. Logo/environment reveal share 340ms,
  cabinet travel is 420ms. PixelPlay and cloth physics remain simulations.
- Scene pigments, dynamic lighting, map previews and material-derived colors
  are not UI tokens. Do not neutralize or normalize them with the chrome.

## Adding or changing a control

Open `/room/components` to inspect the real UI without the cloth scene. Each
specimen runs in its own document, so token edits also reach its real portals
without affecting the live room. Drafts use the separate
`loom.component-workbench.v1` storage key; reset and CSS export are explicit.
Exported values are reviewable drafts, not automatic source-file updates.

Reuse a native control and existing component first. Use a shared token when
the value has the same role; keep a genuinely different geometry or optical
offset local. The spacing steps are common values, not a mandate to round
every existing 6/10/14/18px inset and change the composition.

Check open/closed, selected/disabled, keyboard focus, narrow/coarse input,
reduced motion, reduced transparency, and high contrast. For a refactor,
compare computed styles before and after rather than accepting a similar look.

Run `npx vitest run lib/ui/designSystem.test.ts` for token-reference, sizing,
motion, slider-variant and route-isolation contracts. These are source contracts,
not substitutes for real browser layout and interaction checks.
