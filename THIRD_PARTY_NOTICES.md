# Third-party notices and provenance

## claude-office

- Original project: **claude-office**
- Original author and copyright holder: **TOPLAIN SOFT**
- Copyright notice: **Copyright (c) 2026 TOPLAIN SOFT**
- Source: https://github.com/toplainsoft/claude-office
- Base revision: `3c3d110ed2d398a745acfa76550c2dab993647e3`
- License: **MIT**. The complete original copyright notice and permission notice are preserved in [LICENSE](LICENSE).

This repository is a modified Codex-focused version of that project. The office scene, Canvas drawing routines, character artwork, furniture, room layout, animation and associated interface are derived from the original `office.html`.

The modified version preserves the office presentation while adding a separate Codex log parser and state reducer, incremental read-only JSONL monitoring, explicit terminal/wait states, conservative tool classification, child-session linking, observed quota handling, a Codex-only demo and regression tests. It removes Claude status-line configuration writes and external font requests, and adjusts the interface for narrow panels.

The screenshot in `docs/preview.png` shows the modified application using synthetic demo data; its office artwork is derived from the original project.

Original files were retrieved from the base revision's `main` state on 2026-10-25. Modifications were made on 2026-10-25. This modified distribution is provided under the MIT License, with the original notices retained.
