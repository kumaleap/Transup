# Transup.ai Homepage Design

## Goal

Build a GitHub Pages friendly homepage for `transup.ai`, positioned as an enterprise AI agent workspace. The page should borrow the product-led clarity of Onlook's homepage without copying its copy, visuals, or brand system.

## Audience

The primary audience is enterprise teams evaluating AI agents for operational work. The page should feel useful to leaders and operators who care about controlled execution, traceability, workflow integration, and human approval.

## Positioning

Transup.ai is an AI agent workspace for enterprise teams. It helps teams coordinate specialist agents across research, planning, execution, review, and delivery while keeping humans in control.

Primary headline:

> AI agents that move enterprise work forward

Supporting message:

> Transup.ai gives teams a controlled workspace where agents can research, plan, execute, and hand work back for review before delivery.

## Page Structure

### Navigation

The top navigation should be minimal and product-focused:

- Brand: `transup.ai`
- Links: `Product`, `Agents`, `Workflow`, `Security`, `FAQ`
- Primary CTA: `Request access`

The navigation should stay visually quiet and not compete with the hero.

### Hero

The first viewport should communicate the product immediately:

- Large headline and concise enterprise-oriented supporting copy.
- Primary CTA: `Request access`.
- Secondary CTA: `View workflow`.
- A polished product workspace preview built with HTML and CSS.

The preview should show a realistic agent workspace, not a generic dashboard. It should include:

- Active work brief.
- Specialist agent list.
- Execution timeline.
- Human review or approval state.
- Audit or delivery status.

### Product Value Sections

Use four compact feature sections:

- `Coordinate specialist agents`: assign agents to research, planning, execution, and review.
- `Keep humans in control`: route important decisions through approvals.
- `Connect enterprise workflows`: represent integrations with docs, tickets, CRM, and internal tools without promising specific unavailable integrations.
- `Measure every handoff`: show progress, logs, ownership, and traceability.

### Workflow

Show the end-to-end workflow as a clear sequence:

`Brief -> Plan -> Execute -> Review -> Deliver`

This section should make clear that Transup.ai is a workflow execution layer, not just a chat interface.

### Trust And Security

Include a concise trust section with non-inflated claims:

- Permission boundaries.
- Human approval.
- Audit trail.
- Workspace memory.

Do not invent customer logos, compliance certifications, or deployment modes.

### FAQ

Include practical questions:

- What teams is Transup.ai for?
- Is this a chatbot?
- Can humans review agent work?
- What tools does it connect to?
- How do we get access?

### Final CTA

Close with a direct CTA:

`Bring agents into real enterprise work`

Primary action: `Request access`.

## Visual Direction

Use the approved `Product Workspace` direction:

- Calm premium layout.
- Warm neutral background with high contrast text.
- Dark product preview panel.
- Soft borders and subtle shadows.
- Minimal navigation.
- Product preview as the main visual asset.

Avoid:

- Decorative gradient blobs.
- Fake customer logos.
- Overly abstract AI imagery.
- Marketing sections that do not explain the product.

## Technical Approach

Use a static site:

- `index.html`
- `styles.css`
- `script.js`

No build system is required. This keeps deployment simple for GitHub Pages. The site should work by opening `index.html` directly and should also work through a basic static server.

## Responsiveness

The design must support:

- Desktop widths around 1440px.
- Tablet widths.
- Mobile widths around 390px.

The product preview should stack below the hero copy on smaller screens. Navigation links can collapse or simplify on mobile, but the CTA and brand should remain visible.

## Verification

Before considering the implementation complete:

- Open the page locally.
- Check desktop and mobile layouts.
- Confirm no text overlaps.
- Confirm CTAs and anchor links work.
- Confirm the page does not rely on external assets.

