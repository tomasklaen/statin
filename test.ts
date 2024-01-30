import test from 'ava';
import {signal, computed, once, reaction, action, createAction, toJS, nameFn, CircularReactionError} from './src/index';

test(`calling a signal with no argument reads it`, (t) => {
	const s = signal('foo');
	t.is(s(), 'foo');
});

test(`signal.get reads the signal`, (t) => {
	const s = signal('foo');
	t.is(s.get(), 'foo');
});

test(`signal.r() is an alias of signal.get()`, (t) => {
	const s = signal('foo');
	t.is(s.get, s.r);
});

test(`calling a signal with one argument sets it`, (t) => {
	const s = signal('foo');
	s('bar');
	t.is(s(), 'bar');
});

test(`signal.set(value) sets the signal`, (t) => {
	const s = signal('foo');
	s.set('bar');
	t.is(s(), 'bar');
});

test(`signal.w() is an alias of signal.set()`, (t) => {
	const s = signal('foo');
	s.set('bar');
	t.is(s.set, s.w);
});

test(`signal.value points to the current value`, (t) => {
	const obj = {};
	const s = signal<any>(obj);
	t.is(s.value, obj);
	s('foo');
	t.is(s.value, 'foo');
});

test(`signal.toJSON() returns current value`, (t) => {
	const obj = {};
	const s = signal(obj);
	t.is(s.toJSON(), obj);
});

test(`JSON.stringify() serializes a signal`, (t) => {
	const s = signal('foo');
	t.is(JSON.stringify(s), '"foo"');
});

test(`JSON.stringify() serializes a signal deeply`, (t) => {
	const s = signal({
		foo: signal('foo'),
		bar: signal([signal(1), signal(2)]),
	});
	t.is(JSON.stringify(s), '{"foo":"foo","bar":[1,2]}');
});

test(`toJS() unwraps a signal`, (t) => {
	const s = signal('foo');
	t.is(toJS(s), 'foo');
});

test(`toJS() unwraps a signal deeply`, (t) => {
	const s = signal({
		foo: signal('foo'),
		bar: signal([signal(1), signal(2)]),
	});
	t.deepEqual(toJS(s), {foo: 'foo', bar: [1, 2]});
});

test(`nameFn() attaches displayName to functions`, (t) => {
	function rawFunction() {}
	const arrowFunction = () => {};
	t.is(nameFn('FOO', rawFunction).displayName, 'FOO');
	t.is(nameFn('FOO', arrowFunction).displayName, 'FOO');
	t.is(nameFn('FOO', function () {}).displayName, 'FOO');
	t.is(nameFn('FOO', function bar() {}).displayName, 'FOO');
	t.is(nameFn('FOO', () => {}).displayName, 'FOO');
});

test(`once() listens and execute effect once`, (t) => {
	const s = signal('foo');
	let count = 0;
	once(
		() => s(),
		() => count++
	);
	t.is(count, 0);
	s('bar');
	t.is(count, 1);
	s('baz');
	t.is(count, 1);
});

test(`once() passes a disposer to action as 1st argument`, (t) => {
	const s = signal('foo');
	let count = 0;
	once(
		(dispose) => {
			s();
			dispose();
		},
		() => count++
	);
	s('bar');
	t.is(count, 0);
});

test(`once() internal disposer clears even dependencies created after it's been called`, (t) => {
	const a = signal('foo');
	const b = signal('foo');
	let count = 0;
	once(
		(dispose) => {
			a();
			dispose();
			b();
		},
		() => count++
	);
	a('bar');
	b('bar');
	t.is(count, 0);
});

test(`signal(value) bulks effects`, (t) => {
	const s = signal(1);
	const c = computed(() => s() * 10);
	t.plan(1);
	reaction(
		() => {
			s();
			c();
		},
		() => t.pass()
	);
	s(2);
});

test(`signal.change() triggers signal observers`, (t) => {
	const s = signal('foo');
	t.plan(1);
	once(
		() => s(),
		() => t.pass()
	);
	s.changed();
});

test(`signal.edit() runs immediately, and passes the current value as 1st argument`, (t) => {
	const s = signal('foo');
	t.plan(1);
	s.edit((value) => {
		t.is(value, 'foo');
	});
});

test(`signal.edit() doesn't subscribe the signal`, (t) => {
	const s = signal('foo');
	t.plan(0);
	once(
		() => s.edit(() => {}),
		() => t.fail()
	);
	s('bar');
});

test(`signal.edit() sends a changed signal after editor finishes`, (t) => {
	const s = signal(['foo', 'bar']);
	t.plan(1);
	once(
		() => s(),
		() => t.deepEqual(s(), ['foo'])
	);
	s.edit((s) => s.pop());
});

test(`reaction(action) continually executes action as dependencies change`, (t) => {
	const foo = signal('foo');
	const bar = signal('bar');
	const results: string[] = [];
	reaction(() => {
		results.push(foo());
		results.push(bar());
	});
	foo('fam');
	t.deepEqual(results, ['foo', 'bar', 'fam', 'bar']);
	bar('baz');
	t.deepEqual(results, ['foo', 'bar', 'fam', 'bar', 'fam', 'baz']);
});

test(`reaction(action) returns its disposer`, (t) => {
	const foo = signal('foo');
	const bar = signal('bar');
	const results: string[] = [];
	const dispose = reaction(() => {
		results.push(foo());
		results.push(bar());
	});
	bar('baz');
	t.deepEqual(results, ['foo', 'bar', 'foo', 'baz']);
	dispose();
	foo('fam');
	t.deepEqual(results, ['foo', 'bar', 'foo', 'baz']);
});

test(`reaction(action) passes disposer as 1st argument to the action`, (t) => {
	const s = signal('foo');
	const cancel = signal(false);
	const results: string[] = [];
	reaction((dispose) => {
		results.push(s());
		if (cancel()) dispose();
	});
	t.deepEqual(results, ['foo']);
	s('bar');
	t.deepEqual(results, ['foo', 'bar']);
	cancel(true);
	t.deepEqual(results, ['foo', 'bar', 'bar']);
	s('baz');
	t.deepEqual(results, ['foo', 'bar', 'bar']);
});

test(`reaction(action) doesn't allow action to trigger itself`, (t) => {
	const a = signal(1);
	t.plan(1);
	reaction(() => {
		a(a() + 1);
		t.pass();
	});
});

test(`reaction(action, {onError}) catches and triggers onError`, (t) => {
	t.plan(1);
	reaction(
		function MyReaction() {
			throw new Error('foo');
		},
		{onError: (error) => t.is(error.message, 'Error in MyReaction: foo')}
	);
});

test(`reaction(action, effect) executes the effect as action dependencies change`, (t) => {
	const s = signal('foo');
	let actionCount = 0;
	let effectCount = 0;
	reaction(
		() => {
			actionCount++;
			s();
		},
		() => effectCount++
	);
	t.is(actionCount, 1);
	t.is(effectCount, 0);
	s('bar');
	t.is(actionCount, 2);
	t.is(effectCount, 1);
});

test(`reaction(action, effect) passes the value returned by action to effect`, (t) => {
	const s = signal('foo');
	t.plan(1);
	reaction(
		() => `${s()}Action`,
		(value) => t.is(value, 'barAction')
	);
	s('bar');
});

test(`reaction(action, effect) passes its disposer as 1st argument to action`, (t) => {
	const s = signal('foo');
	const cancel = signal(false);
	let actionCount = 0;
	let effectCount = 0;
	reaction(
		(dispose) => {
			actionCount++;
			s();
			if (cancel()) dispose();
		},
		() => effectCount++
	);
	t.is(actionCount, 1);
	t.is(effectCount, 0);
	cancel(true);
	t.is(actionCount, 2);
	t.is(effectCount, 1);
	s('bar');
	t.is(actionCount, 2);
	t.is(effectCount, 1);
});

test(`reaction(action, effect) passes its disposer as 2nd argument to effect`, (t) => {
	const s = signal('foo');
	let actionCount = 0;
	let effectCount = 0;
	reaction(
		() => {
			actionCount++;
			s();
		},
		(value, dispose) => {
			effectCount++;
			dispose();
		}
	);
	t.is(actionCount, 1);
	t.is(effectCount, 0);
	s('bar');
	t.is(actionCount, 2);
	t.is(effectCount, 1);
	s('baz');
	t.is(actionCount, 2);
	t.is(effectCount, 1);
});

test(`reaction(action, effect) doesn't allow action to trigger itself`, (t) => {
	const a = signal(1);
	t.plan(3);
	reaction(
		() => {
			a(2);
			a();
			t.pass();
		},
		() => t.pass()
	);
	a(-1);
});

test(`reaction(action, effect) detects and disposes circular reactions`, (t) => {
	const count = signal(-1);
	const myAction = () => count();
	const myEffect = (currentCount: number) => count(currentCount + 1);
	reaction(myAction, myEffect, {
		onError: (error) => {
			t.true(error instanceof CircularReactionError);
			t.true(error?.message.startsWith('Circular reaction in myAction->myEffect'));
		},
	});
	action(() => count(0));
	t.is(count.value, 101);
});

test(`reaction(action, effect, {immediate: true}) triggers effect immediately`, (t) => {
	const a = signal(1);
	t.plan(1);
	reaction(
		() => a(),
		(value) => t.is(value, 1),
		{immediate: true}
	);
});

test(`reaction(action, effect, {onError}) catches and triggers onError from action`, (t) => {
	t.plan(1);
	reaction(
		function MyReaction() {
			throw new Error('foo');
		},
		function MyEffect() {},
		{onError: (error) => t.is(error.message, 'Error in MyReaction: foo')}
	);
});

test(`reaction(action, effect, {onError}) catches and triggers onError from effect`, (t) => {
	const s = signal(-1);
	t.plan(1);
	reaction(
		function MyReaction() {
			s();
		},
		function MyEffect() {
			throw new Error('foo');
		},
		{onError: (error) => t.is(error.message, 'Error in MyEffect: foo')}
	);
	s(0);
});

test(`reaction(action, effect, {immediate, onError}) catches and triggers onError from effect`, (t) => {
	t.plan(1);
	reaction(
		function MyReaction() {},
		function MyEffect() {
			throw new Error('foo');
		},
		{immediate: true, onError: (error) => t.is(error.message, 'Error in MyEffect: foo')}
	);
});

test(`computed() creates a computed signal`, (t) => {
	const foo = signal('foo');
	const c = computed(() => `${foo()}bar`);
	t.is(c(), 'foobar');
});

test(`computed(fn) receives previous value`, (t) => {
	const n = signal(2);
	const c = computed<number>((prev) => n() * (prev ?? 1));
	t.is(c(), 2);
	n(3);
	t.is(c(), 6);
});

test(`computed() only re-computes when one of the dependencies change`, (t) => {
	const foo = signal('foo');
	const bar = signal('bar');
	let count = 0;
	const c = computed(() => {
		count++;
		return `${foo()}${bar()}`;
	});
	t.is(c(), 'foobar');
	t.is(c(), 'foobar');
	t.is(c(), 'foobar');
	foo('fam');
	t.is(c(), 'fambar');
	t.is(count, 2);
});

test(`computed() propagates changed signals of its dependencies`, (t) => {
	const foo = signal('foo');
	const bar = signal('bar');
	const a = computed(() => `${foo()}${bar()}`);
	const b = computed(() => `${a()}Parent`);
	t.plan(2);
	once(
		() => a(),
		() => t.pass()
	);
	foo('fam');
	once(
		() => b(),
		() => t.pass()
	);
	bar('baz');
});

test(`action() de-duplicates and bulks all updates to the end`, (t) => {
	const a = signal(1);
	const b = signal(1);
	const outside = signal(1);
	const c = computed(() => `${a()}${outside()}`);
	t.plan(2);
	reaction(() => {
		t.pass();
		a();
		b();
		c();
	});
	action(() => {
		a(2);
		a(3);
		b(2);
		outside(2);
	});
});

test(`action() returns the value`, (t) => {
	t.is(
		action(() => 'foo'),
		'foo'
	);
});

test(`action() prevents signals from being tracked`, (t) => {
	const a = signal(1);
	const b = signal(1);
	const c = signal(1);
	let count = 0;
	reaction(() => {
		count++;
		a();
		action(() => b());
		c();
	});
	t.is(count, 1);
	a(2);
	t.is(count, 2);
	b(2);
	t.is(count, 2);
	c(2);
	t.is(count, 3);
});

test(`action() doesn't prevent computed signal from updating`, (t) => {
	const a = signal('f');
	const b = signal('b');
	const aIs = computed(() => `a:${a()}`);
	const bIs = computed(() => `b:${b()}`);
	const allAre = computed(() => `${aIs()}, ${bIs()}`);
	action(() => {
		t.is(allAre(), 'a:f, b:b');
		b('bar');
		t.is(allAre(), 'a:f, b:bar');
	});
});

test(`action() triggers effects even when it throws`, (t) => {
	const a = signal('foo');
	t.plan(3);
	reaction(() => {
		a();
		t.pass();
	});
	t.throws(() =>
		action(() => {
			a('bar');
			throw new Error('foo');
		})
	);
});

test(`action() inside action() doesn't resume dependency tracking`, (t) => {
	const a = signal('f');
	const b = signal('b');
	t.plan(0);
	reaction(
		() => {
			action(() => {
				a();
				action(() => {});
				b();
			});
		},
		() => t.pass()
	);
	a('foo');
	b('bar');
});

test(`once() inside action() still tracks its dependencies`, (t) => {
	const s = signal('foo');
	t.plan(1);
	action(() => {
		once(
			() => s(),
			() => t.pass()
		);
		s('bar');
	});
});

test(`reaction() inside action() still tracks its dependencies`, (t) => {
	const s = signal('foo');
	t.plan(1);
	action(() => {
		const dispose = reaction(
			() => s(),
			() => t.pass()
		);
		s('bar');
		dispose();
	});
});

test(`once() inside once() doesn't cancel tracking`, (t) => {
	const s = signal('f');
	t.plan(1);
	once(
		() => {
			once(
				() => {},
				() => {}
			);
			s();
		},
		() => t.pass()
	);
	s('foo');
});

test(`computed() updates even within an action`, (t) => {
	const a = signal('f');
	const b = signal('b');
	let count = 0;
	const c = computed(() => {
		count++;
		return `${a()}${b()}`;
	});
	t.plan(3);
	action(() => {
		t.is(c(), 'fb');
		a('foo');
		b('bar');
		t.is(c(), 'foobar');
		t.is(count, 2);
	});
});

test(`createAction() wraps the action, inheriting arguments and return value`, (t) => {
	const a = signal(1);
	const b = signal(1);
	const outside = signal(1);
	const c = computed(() => `${a()}${outside()}`);
	t.plan(3);
	reaction(() => {
		t.pass();
		a();
		b();
		c();
	});
	const action = createAction((value: string) => {
		a(2);
		a(3);
		b(2);
		outside(2);
		return `${value}bar`;
	});
	t.is(action('foo'), 'foobar');
});

test(`computed() throws when signal is written into inside of it`, (t) => {
	const a = signal(1);
	const c = computed(() => a(2));
	t.throws(c);
});

test(`computed() describes errors correctly`, (t) => {
	const a = computed(function ComputeA() {
		throw new Error('foo');
	});
	const b = computed(
		nameFn('ComputeB', () => {
			throw new Error('foo');
		})
	);
	t.throws(a, {message: 'Error in ComputeA: foo'});
	t.throws(b, {message: 'Error in ComputeB: foo'});
});

test(`computed() recovers from errors`, (t) => {
	const errorOut = signal(true);
	const c = computed(function ComputeFoo() {
		if (errorOut()) throw new Error('foo');
		return 'foo';
	});
	const error = t.throws(c);
	// Caches original error
	t.is(t.throws(c), error);
	errorOut(false);
	t.is(c(), 'foo');
});

test(`reaction(action) recovers from errors`, (t) => {
	const errorOut = signal(true);
	t.plan(2);
	reaction(
		function MyReaction() {
			if (errorOut()) throw new Error('foo');
			t.pass();
		},
		{onError: (error) => t.is(error.message, 'Error in MyReaction: foo')}
	);
	errorOut(false);
});

test(`reaction(action, effect) recovers from error in action`, (t) => {
	const errorOut = signal(true);
	t.plan(3);
	reaction(
		function MyAction() {
			if (errorOut()) throw new Error('foo');
			t.pass();
		},
		function MyEffect() {
			t.pass();
		},
		{onError: (error) => t.is(error.message, 'Error in MyAction: foo')}
	);
	errorOut(false);
});

test(`reaction(action, effect) recovers from error in effect`, (t) => {
	const errorOut = signal(false);
	t.plan(5);
	reaction(
		function MyAction() {
			t.pass();
			return errorOut();
		},
		function MyEffect(errorOut) {
			if (errorOut) throw new Error('foo');
			t.pass();
		},
		{onError: (error) => t.is(error.message, 'Error in MyEffect: foo')}
	);
	errorOut(true);
	errorOut(false);
});

test(`reaction(action) that throws doesn't stop the effect queue`, (t) => {
	const errorOut = signal(false);
	t.plan(3);
	reaction(
		() => {
			if (errorOut()) throw new Error('foo');
		},
		{onError: () => t.pass()}
	);
	reaction(() => {
		errorOut();
		t.pass();
	});
	errorOut(true);
});

test(`reaction(action, effect) that throws doesn't stop the effect queue`, (t) => {
	const errorOut = signal(false);
	t.plan(3);
	reaction(
		() => errorOut(),
		(errorOut) => {
			if (errorOut) throw new Error('foo');
		},
		{onError: () => t.pass()}
	);
	reaction(() => {
		errorOut();
		t.pass();
	});
	errorOut(true);
});

test(`reaction(action) onError(_, dispose) disposes reaction`, (t) => {
	const a = signal('foo');
	t.plan(1);
	reaction(
		() => {
			t.pass();
			a();
			throw new Error('foo');
		},
		{onError: (_, dispose) => dispose()}
	);
	a('bar');
});

test(`reaction(action, effect) action onError(_, dispose) disposes reaction`, (t) => {
	const a = signal('foo');
	t.plan(1);
	reaction(
		() => {
			t.pass();
			a();
			throw new Error('foo');
		},
		() => {
			t.fail();
		},
		{onError: (_, dispose) => dispose()}
	);
	a('bar');
});

test(`reaction(action, effect) effect onError(_, dispose) disposes reaction`, (t) => {
	const a = signal('foo');
	t.plan(2);
	reaction(
		() => {
			t.pass();
			a();
		},
		() => {
			throw new Error('foo');
		},
		{onError: (_, dispose) => dispose()}
	);
	a('bar');
	a('baz');
});

test(`action() that throws inside reaction(action) doesn't break effect queue`, (t) => {
	const check = signal(false);
	const go = signal(false);
	t.plan(3);
	reaction(() => {
		if (check()) t.pass();
	});
	reaction(
		() => {
			if (check()) t.pass();
			if (go()) {
				action(() => {
					check(true);
					throw new Error('foo');
				});
			}
		},
		{onError: (error) => t.pass()}
	);
	reaction(() => {
		if (check()) t.pass();
	});
	go(true);
});
