# Local knowledge and action memory

Shabang has two separate local knowledge paths:

- **Profile and answers:** facts the user keeps in profile.json plus bounded learned answers.
- **Action memory:** bounded role-level outcomes used to reorder accessible next-action suggestions.

The shared modules provide the pure extraction, ranking, role, and memory logic. The macOS app owns the actual files and the user-facing behavior. This separation keeps the first suggestion useful from generic structure while allowing repeated choices to influence later suggestions locally.

The current product does not claim a universal personal graph, cloud synchronization, automatic source ingestion, or a model that learns continuously from raw screen content. See [local data](storage.md), [form answers](answers.md), and [next-action suggestions](anywhere.md).
