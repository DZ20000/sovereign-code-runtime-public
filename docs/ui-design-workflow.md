# Frontend design workflow

The application maintains an editable Figma design for every visible frontend surface. Design changes precede implementation changes. The catalog is a working product design, not a collection of flattened screenshots.

## Surface coverage

| Route or window | Design coverage |
| --- | --- |
| Home & Connections (`overview`; Chinese: 概览与连接) | Full and simple modes; host/workspace summaries; ChatGPT and Gemini cards; configuration drawers; protected-value editing; public-configuration import and presets; advanced connection and local MCP controls |
| Tasks (`tasks`) | Project and directory selection; current/history queues; selected task; explicitly reported progress and steps; text conversation and coordination inbox; terminal output/logs and all-run history, including unassociated runs |
| Approvals & Audit (`approvals`) | Pending approvals, request details, decision/result states, audit search and outcome filters |
| Settings (`settings`) | General and appearance; Workspace and permissions; Advanced and diagnostics. Host startup belongs to General; workspace permission editing has one Settings form. |
| Terminal (`terminal`) | Session list, command/output, session options, resize and close |
| Python (`python`) | Interpreter state, editor, execution options, output and activity |
| Browser (`browser`) | Domain boundary, sessions, navigation, observation, elements and advanced actions |
| Desktop Control (`computer`) | Windows, observations, target actions, keyboard/text and advanced actions |
| Workflows (`workflows`) | Templates, fields, step builder, validation and advanced JSON |
| Approval window | Pending, submitting, uncertain, expired, unavailable and administrator-handoff states; focus, return and decision behavior |

The four primary routes are Home & Connections, Tasks, Approvals & Audit, and Settings. The five developer tools are grouped in a collapsible area in full mode and hidden in simple mode. Simple mode remains a compact companion surface.

Task conversation is text-only. Run history is part of Tasks; audit is part of Approvals & Audit. Design references must not imply attachment upload, automatic task planning, run retries or task-level cancellation without the corresponding implementation.

Shared navigation, page headings, status indicators, notifications and layout modes are part of the catalog. An update-preflight window reuses the application renderer; it is not a separate product page.

Unused historical view definitions do not become new navigation pages merely because they remain in source.

## Working sequence

Update the relevant Figma view first. Retain the existing product's tokens and controls where they suit the change, and use reusable component instances for repeated UI. Keep advanced options collapsible and show the next useful action clearly.

Implement with the existing shared DOM renderer and the two desktop transports. A design-only frame does not establish that functionality has shipped. Record which surfaces were implemented and which remain design references.

Use the isolated visual fixture to verify language changes, keyboard operation, narrow windows, errors and the important states of the affected flow. Readability, interaction and truthful status take precedence over decorative changes. The [UI v2 validation guide](ui-v2-source-validation.md) records implementation boundaries and the source/package evidence required for release.

## Design data and publication

Use generic sample projects, domains and requests in designs and fixtures. Do not include real workspace paths, account credentials, identity-provider values, personal conversations or live application state.

The private editable catalog can be linked in the working conversation or local project coordination record. Public repository documentation records the workflow and surface inventory without embedding private account bindings.

The current desktop source uses the Windows Segoe UI font stack. If a design service lacks that font, document the substitute in the design file and preserve the actual product font during implementation.
