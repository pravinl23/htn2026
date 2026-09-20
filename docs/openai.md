# OpenAI vision experiment

The server implements optional OpenAI vision endpoints that can label or locate controls from supplied screen crops. The service re-checks sensitivity and irreversible-action status in code; a model response cannot unlock an action or execute anything.

This work is **experimental**. It requires OPENAI_API_KEY, Screen Recording permission, a process budget, and request validation. The desktop next-action path can use it for eligible unnamed controls, but that does not make it general icon-control support.

The endpoints are:

- GET /v1/vision for availability, cache, and budget status;
- POST /v1/vision/label for a bounded batch of control labels;
- POST /v1/vision/locate for a bounded location request.

These routes have additional local-caller checks beyond the normal loopback guard. Requests are validated, sent once to the configured provider, and then discarded; logs are designed to retain counts and status rather than screen contents. See [the server API note](server-api.md) before enabling it.
