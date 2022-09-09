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
</p>

# How to install
```
npm install @ocoda/event-sourcing
```

# Event-store setup
The event-store is the database layer of your event-sourced application, responsible for storing and fetching events that have occurred. Each event gets wrapped along with some metadata into an event-envelope and appended to an event-stream.

## Available event stores:
You can create and provide your own implementation of the event-store or make use of one of the following:

### InMemory: 
An in-memory event-store implementation, useful for testing purposes.
```typescript
EventSourcingModule.forRoot({ 
	database: 'in-memory',
	events: [...] 
}),
```

### MongoDB
Requires the MongoDB package to be installed
```
npm install mongodb
```
```typescript
EventSourcingModule.forRoot({ 
	database: 'in-memory',
	connection: { url: 'mongodb://localhost:27017' },
	events: [...] 
}),
```

### Elasticsearch
Requires the ElasticSearch package to be installed
```
npm install @elastic/elasticsearch@^7.0.0
```
```typescript
EventSourcingModule.forRoot({ 
	database: 'mongodb',
	connection: { node: 'http://localhost:9200' },
	events: [...] 
}),
```

### Custom
Provide your own EventStore implementation
```typescript
import { EventStore } from '@ocoda/event-sourcing';

@Module({
  // TODO
})
```
