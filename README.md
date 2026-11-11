# Kelay

A cloud for small software. A builder describes an agent app, ships it to real users, and keeps improving it from their feedback.

- **Product prototype:** [`design/prototype/index.html`](design/prototype/index.html). This is the canonical prototype; open it in a browser. It has:
  - Home and My Apps;
  - a Workspace with Screen, Monitoring, Users and Feedback tabs, plus the Builder agent;
  - the App Graph and the share modals.
- **Infrastructure design:** [`docs/infrastructure.md`](docs/infrastructure.md). It covers the decisions, the trust boundary, key flows, environments and build order.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/stack-diagram-dark.png">
  <img src="docs/stack-diagram.png" alt="Kelay infrastructure stack diagram on AWS Seoul with Cloudflare at the edge and Anthropic, OpenAI and Gemini as model providers" width="100%">
</picture>
