<p align="center">
	<a href="http://ocoda.io/" target="blank"><img src="https://github.com/ocoda/.github/raw/master/assets/ocoda_logo_full_gradient.svg" width="600" alt="Ocoda Logo" /></a>
</p>

<p align="center">
	<a href="https://dl.circleci.com/status-badge/redirect/gh/ocoda/event-sourcing/tree/master">
		<img src="https://dl.circleci.com/status-badge/img/gh/ocoda/event-sourcing/tree/master.svg?style=shield&circle-token=a100516020508c3af55331a6000b671c6bc94f62">
	</a>
	<a href="https://codecov.io/gh/ocoda/event-sourcing">
		<img src="https://codecov.io/gh/ocoda/event-sourcing/branch/master/graph/badge.svg?token=D6BRXUY0J8">
	</a>
	<a href="https://github.com/ocoda/event-sourcing/blob/master/LICENSE.md">
		<img src="https://img.shields.io/badge/License-MIT-green.svg">
	</a>
</p>

This library was created to help people get started with event-sourcing in NestJS. Event-sourcing is the practice of capturing state **transitions** in your domain models instead of only capturing the current state. It contains the building blocks to implement Command query responsibility segregation, store events and snapshots, publish events and much more.

# Getting started
To get started with this library, you need to install it first.
```
npm install @ocoda/event-sourcing
```
This library currently provides wrappers for storing events and snapshots for MongoDB and Elasticsearch. To make use of database wrappers, you will need to install their respective libraries:
```
npm install @elastic/elasticsearch # For using ElasticSearch
npm install mongodb # For using MongoDB
```
For testing purposes no database wrapper is required, this library ships with a fully functional in-memory store.

Once you have installed all required packages we can import the EventSourcingModule into the root AppModule of your application. The configuration itself depends on the type of database you want to use and if you want to make use of snapshots.
```typescript
@Module({
  imports: [
    EventSourcingModule.forRoot({
		eventStore: {
			client: 'mongodb',
			options: { 
				url: 'mongodb://localhost:27017' 
			},
		},
		snapshotStore: {
			client: 'elasticsearch',
			options: {
				node: 'http://localhost:9200',
			}
		},
		events: [...Events],
    }),
})
export class AppModule {}
```

# Aggregates
// TODO: explain AggregateRoot and the @Aggregate decorator

# Commands
// TODO: Explain what Commands and CommandHandlers are

# Events
// TODO: Explain the @Event decorator, what it defaults to, how this reflects in the event-store, event streams, event-envelopes, how serialization can be customized, publishing, ...

## EventStore
// TODO: Explain how the event-store works (using streamIds, pools for multi-tenancy, etc.)

# Repositories
// TODO: Explain what aggregate repositories are and how they work

# Snapshots
// TODO: Explain the @Snapshot decorator, SnapshotHandlers (and how serialization must be customized), how this reflects in the snapshot-store, snapshot streams, snapshot envelopes, ...

## SnapshotStore
// TODO: Explain how the snapshot-store works (using streamIds, pools for multi-tenancy, etc.)

# Queries
// TODO: Explain what Queries and QueryHandlers are

# Misc
// TODO: Explain Value Objects, Id's, ...
