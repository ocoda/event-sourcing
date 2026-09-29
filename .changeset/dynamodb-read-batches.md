---
'@ocoda/event-sourcing-dynamodb': patch
---

Fix the batches that the read methods of the DynamoDB stores yield.

- A batch is no longer emptied once the consumer asks for the next one, so consumers can keep a reference to a batch, for example to collect all batches before processing them. Before, every batch that was kept ended up empty. This affects `getEvents`, `getEnvelopes` and `getAllEnvelopes` of the event store, and `getSnapshots`, `getEnvelopes` and `getLastEnvelopesForAggregate` of the snapshot store.
- `listCollections` yields the collections of every page of at most `batch` tables as it reads them, instead of collecting all pages and yielding everything at once.
