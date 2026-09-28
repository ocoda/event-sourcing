import { Observable, Subject } from 'rxjs';

export class ObservableBus<T> extends Observable<T> {
	protected _subject$ = new Subject<T>();

	constructor() {
		super();
		// Use the subject as the source of this observable, so subscribing to (or piping from) the bus itself
		// receives the values that are pushed onto the subject.
		this.source = this._subject$;
	}

	public get subject$() {
		return this._subject$;
	}
}
