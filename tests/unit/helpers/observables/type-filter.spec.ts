import { IEvent, typeFilter } from '../../../../lib';
import { Subject } from 'rxjs';

describe(typeFilter, () => {
	class A implements IEvent {}
	class B implements IEvent {}
	class SubA extends A {}
	class C implements IEvent {}

	let stream: Subject<any>;
	let output: IEvent[];
	let expectedResults: IEvent[];

	beforeEach(() => {
		stream = new Subject();
		output = [];
		expectedResults = [];

		stream.pipe(typeFilter(A)).subscribe((event) => output.push(event));
	});

	it('filters all the events when none is an instance of the given types', async () => {
		stream.next(new B());
		stream.next(new C());
		stream.next(new B());

		expect(output).toEqual([]);
	});

	it('filters instances of events to keep those of the given types', async () => {
		expectedResults.push(new A());

		stream.next(new B());
		stream.next(new A());
		stream.next(new Date());

		expect(output).toEqual(expectedResults);
	});

	it('does not filter instances of classes extending the given types', async () => {
		expectedResults.push(new A(), new SubA());

		stream.next(new B());
		expectedResults.forEach((event) => stream.next(event));

		expect(output).toEqual(expectedResults);
	});
});
