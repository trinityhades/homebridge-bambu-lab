---
description: When editing code for Bambu X1C Homebridge plugin, follow these guidelines to ensure consistency and maintainability.
# applyTo: 'Describe when these instructions should be loaded' # when provided, instructions will automatically be added to the request context when the pattern matches an attached file
---
use 'npm run dev' to build, lint, and restart Homebridge automatically during development.
npm run build 2>&1 && npm run lint 2>&1 && sudo hb-service restart is the equivalent command for production builds.