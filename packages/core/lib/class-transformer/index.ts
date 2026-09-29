// The '@ocoda/event-sourcing/class-transformer' entry point, the only one that imports class-transformer (an optional
// peer dependency). The root entry point never requires it: the bootstrap check loads it only if it is installed.
export * from './class-transformer-event-serializer.js';
