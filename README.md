# statin

Simple and tiny reactive state library.

Statin is heavily inspired by MobX, in fact, you can say it's a re-implementation of MobX in as little code as possible.

Features:

-   Tiny, ~4KB min, <2KB gz.
-   Fully typed.
-   View source friendly, it's just a single medium sized file.
-   Clean, straight forward, no-magic API.
-   No proxies, decorators, or other abstractions that introduce non-standard behavior to wrapped objects.
-   Error handling and recovery.
-   Circular reaction detection.

Requirements:

-   `WeakMap`: 96.48% browser support as of January 2022 (IE 11+).
-   `Symbol`: 95.57% browser support as of January 2022 (Edge+).

Bindings:

-   [statin-preact](https://github.com/tomasklaen/statin-preact)

## Install

```
npm install statin
```

## Usage

You can see an interactive example here: [https://codesandbox.io/s/statin-example-yxp4s](https://codesandbox.io/s/statin-example-yxp4s)

Brief summary of statin API:

```ts
import {Signal, signal, computed, reaction} from 'statin';

// Create a signal
const number = signal(4);

// Get value
console.log(number()); // 4

// Set value
number(5);

// Create more signals
const numbers = signal<Signal<number>[]>([number]);
const sum = computed(() => numbers().reduce((sum, value) => sum + value(), 0));

// Create a reaction
const dispose = reaction(() => {
	console.log(`Sum of all numbers is ${sum()}.`);
});

// console.log: Sum of all numbers is 5.

// Update observed signal
number(6);

// console.log: Sum of all numbers is 6.

// Add a new number signal to numbers by mutating it
numbers.edit((array) => array.push(signal(2)));

// console.log: Sum of all numbers is 8.

// Cancel reaction
dispose();
```

NOTE: In a real codebase, all signal updates in the example above should happen inside an [action](#action). You'll get a warning if they don't. Read the action API for more details.

## Project state

Statin was created as a state keeping library for [Drovp](https://drovp.app), which is a non-trivial app with a lot of state requirements. Drovp is as of time of writing in a stable beta, and has no known state/statin related issues.

I consider statin to be stable and feature complete. That's not to say there aren't any issues or improvements to be made. If you've noticed something I've missed, feel free to create an issue.

## API

Everything exported by the module:

### Signal

Interface returned by `signal()` creator below.

```ts
interface Signal<T extends unknown = unknown> {
	(): T;
	(value: T): void;
	value: T;
	changed: () => void;
	edit: (editor: (value: T) => void) => void;
}
```

### signal

```ts
function signal<T extends unknown = unknown>(initial: T): Signal<T>;
```

Creates a signal that will trigger its observers any time a new value is assigned to it. Signal is a function that returns a value when called with no arguments, or sets a value when called with 1 argument. Example:

```ts
const name = signal('John');
// Read value
console.log(name()); // 'John'
// Set value
name('Mike');
console.log(name()); // 'Mike'
```

NOTE: Observers are only notified when value being assigned is different than the current one. Assigning same value will not cause any reactions to run.

Signal also has these properties and methods:

#### `signal.value`

This is a reference to the current signal value. You can use it to read/write the value in non-reactive way. Only touch this if you really know what you're doing, as misuse will lead to stale and/or incorrect state.

#### `signal.changed`

```ts
() => void;
```

A method that allows manually sending changed signal to all of the signal's observers.

#### `signal.edit`

```ts
(editor: (value: T) => void) => void;
```

A convenience method to edit mutable signal values such as arrays, maps, sets,... Example:

```ts
const set = signal(new Set<string>());

// Mutates the set and sends changed signal afterwards
set.edit(set => set.add('foo'));

// This is essentially just a shorthand for
set.value.add('foo');
set.changed();
```

Value returned by editor function is ignored as `signal.edit()` is meant for mutating. If you want to instead swap the value for a new one, just do `signal(newValue)`.

### Computed

Interface returned by `computed()` creator below.

```ts
interface Computed<T extends unknown> {
	(): T;
}
```

### computed

```ts
function computed<T extends unknown>(compute: () => T): Computed<T>;
```

Creates a cached computed value that re-computes and sends changed signal to its observers when any of the signals it depends on changes. Example:

```ts
const n = signal(3);
const nFactorial = computed(() => factorial(n()));

// 1st computation of `factorial(3)`
console.log(nFactorial()); // 6
// returns cached result from 1st
console.log(nFactorial());

n(4);

// 2nd computation of `factorial(4)`
console.log(nFactorial()); // 24
```

##### Error handling

When computed throws, the error is stored, and thrown to each consumer until the computed state is invalidated by any of the signals it depends on (signals read before the error happened). This way computed values can recover.

### action

```ts
function action<T extends unknown>(fn: () => T): T;
```

Calls `fn()` in an action context, which queues and de-duplicates all signal changes, and sends them to their observers only after it completed. Example:

```ts
const value = signal('init');
reaction(() => console.log(value())); // console.log: 'init'

value('foo'); // console.log: 'foo'
value('bar'); // console.log: 'bar'

action(() => {
	value('foo');
	value('bar');
});
// console.log: 'bar'
```

NOTE: Signals read inside an action are not tracked! This means if you execute an action inside a reaction, the signals read inside an action will not be added as dependencies to the parent reaction.

**IMPORTANT!**

EVERY signal change should happen inside an action, even when you're updating only a single signal. This is because you **can't** safely make an assumption that single value change will only send a single change signal, as there can be computed values depending on it, and if some reaction depends on both the signal, as well as the computed value derived from it, it'll run twice every time you change the signal.

To illustrate this, imagine this dependency tree:

```
A: signal

B: computed
└ A

C: computed
└ A

R: reaction
├ A
├ B
└ C
```

If you change the signal **A**, the reaction **R** will run 3 times, as the computed signals **B** and **C** would propagate the change event to reaction **R** as well.

If you instead wrap the change to signal **A** in an action, all 3 change signals are going to be queued, de-duplicated, and reaction **R** triggered correctly only once.

Changing a signal outside an action triggers a console warning.

Functions passed to `reaction()` and `once()` automatically run in an action context.

### createAction

```ts
function createAction<T extends (...args: unknown[]) => unknown)>(run: T): T;
```

A convenience function to wrap common methods in an action. Example:

```ts
const foo = signal(5);
const addToFoo = createAction((amount: number) => foo(foo() + amount));
addToFoo(2);
console.log(foo()); // 7

// This is essentially just a shorthand for:
const addToFoo = (amount: number) => action(() => foo(foo() + amount));
```

Wrapped methods inherit argument and return types.

Why do you need this if it's pretty much the the same amount of characters? When used on a class method, it prettifies better imo :)

### reaction

```ts
type Disposer = () => void;

interface ReactionAction<T extends unknown> {
	(dispose: Disposer): T;
}

export interface ReactionEffect<T extends unknown> {
	(value: T, dispose: Disposer): void;
}

interface ReactionOptions {
	immediate?: boolean; // default: false
	onError?: (error: Error, dispose: Disposer) => void;
}

function reaction<T extends unknown>(action: ReactionAction<T>, options?: ReactionOptions): Disposer;
function reaction<T extends unknown>(
	action: ReactionAction<T>,
	effect: ReactionEffect<T>,
	options?: ReactionOptions
): Disposer;
```

A reaction creator that returns a disposer. It has two supported call signatures:

**`reaction(action, options?)`**

```ts
const foo = signal(5);
const dispose = reaction((dispose) => {
	// This will run when reaction is created,
	// and every time `foo` signal changes.
	console.log(foo());
	// Can also dispose from inside
	dispose();
});
```

**`reaction(action, effect, options?)`**

```ts
const foo = signal(5);
const dispose = reaction(
	// This runs on init and every time `foo` changes
	(dispose) => foo(),
	// This runs only when `foo` changes,
	// or also on init when immediate is enabled.
	// Signals used in effect are not tracked.
	(foo, dispose) => console.log(`foo changed to ${foo}`),
	// Tell reaction that effect should be run on init as well
	{immediate: true}
);
```

#### ReactionOptions

##### immediate

Type: `boolean` _optional_\
Default: `false`

In `reaction(action, effect)`, enabling this will cause effect to also be called for the initial action call.

##### onError

Type: `(error: Error, dispose: Disposer) => void` _optional_

By default, errors in reactions are caught and just logged to the console. This is so that reactions can recover from errors and don't break execution of other reactions in queue.

Specifying `onError()` listener will pass the error to the handler instead of logging it to the console.

If `onError()` handler itself throws, the error is caught and logged to the console.

### once

```ts
interface OnceOptions {
	onError?: (error: Error, dispose: Disposer) => void;
}

function once(action: (dispose: Disposer) => void, effect: () => void, options?: OnceOptions): Disposer;
```

Sets up a single time reaction that runs action to subscribe to all signals inside it, and then triggers effect, **once**, when any of them changes.

This is a lower level single time reaction that needs to be recreated every time the effect is triggered. It's used to implement `reaction` above, as well as bindings for UI libraries.

#### OnceOptions

##### onError

Type: `(error: Error, dispose: Disposer) => void` _optional_

By default, errors in once are caught and just logged to the console. This is so that reactions can recover from errors and don't break execution of other reactions in queue.

Specifying `onError()` listener will pass the error to the handler instead of logging it to the console.

If `onError()` handler itself throws, the error is caught and logged to the console.

### toJS

```ts
function toJS(value: any): any;
```

Converts all signals in `value`, deeply, into pure serialized JavaScript primitives. `value` itself can also be a signal.

The purpose of this is to serialize data that is currently held inside signals. Example:

```ts
class Human {
	name: Signal<string>;
	age: Signal<number>;

	constructor(name: string, age: number) {
		this.name = signal(name);
		this.age = signal(age);
	}
}

const human = new Human('John Doe', 20);
```

Now if we throw the `human` object into:

```ts
JSON.stringify(human);
```

We get this string:

```
{"name":"John Doe","age":20}
```

And if we throw it into:

```ts
toJS(human);
```

We get this object:

```ts
{
	name: 'John Doe',
	age: 20
}
```

In 99.9% cases serializations need to run only occasionally, or are at least throttled, therefore the implementation trades speed for size, and essentially all this does is `JSON.parse(JSON.stringify(value))`. This is still quite fast, but in a case where speed is of utmost importance, a separate implementation would be necessary.

The other side effect of this implementation is that any value that is not serializable into JSON (such as functions) will be dropped.

### setStrict

```ts
function setStrict(value: boolean): void;
```

Enables or disables strict mode, which is **enabled** by default.

Strict mode behavior:

-   Changing a signal outside an action is a console warning.

## Debugging

If any error happens inside a reaction, action, effect, or computed getter, by default you get a generic error message like `Error in Reaction22: ....`.

To help statin identify and name the source of the error, simply name your functions like so:

```ts
// Naming normal functions
reaction(
	function getLoggedUsersCount() {
		return users().fulter((user) => user.isLoggedIn()).length;
	},
	function logLoggedUsersCount(count) {
		console.log(`There is ${count} logged in users.`);
	}
);

// Naming arrow functions
const getLoggedUsersCount = () => users().fulter((user) => user.isLoggedIn()).length;
const logLoggedUsersCount = (count) => console.log(`There is ${count} logged in users.`);

reaction(getLoggedUsersCount, logLoggedUsersCount);
```

If action above throws, you'll get `Error in getLoggedUsersCount: users(...).fulter is not a function`.

Naming functions this way also has a benefit that these names will be removed during minification (when building for production), which automatically makes your bundle smaller with no extra effort.

Alternatively, you can use the `nameFn()` utility, which simply attaches `displayName` property to the function, and statin will pick it up instead of the default name:

```ts
import {nameFn, reaction} from 'statin';
reaction(nameFn('MyReaction', () => {}));
```

## Notable behavior

Everything in statin is synchronous. There is no `setTimeout` or `setImmediate` shenanigans going on.

For example, when triggering a signal change:

```ts
foo('bar');
```

all side effects happen before it returns, UNLESS called inside an action:

```ts
action(() => foo('bar'));
```

in which case they happen _just_ before the **action** returns.

---

Signals read inside an action are not tracked. This means that in this example:

```ts
reaction(() => {
	foo();
	action(() => bar());
});
```

reaction will not track the `bar()` signal.

---

Signals changed inside a reaction will not re-trigger the current reaction. For example, in this snippet:

```ts
reaction(() => {
	foo(); // adds foo() as a reaction dependency
	foo('bar'); // changes foo()
});
```

changing `foo()` **DOESN'T** cause the reaction to run again after it's finished.

On the other hand, changing the signal in an effect **WILL** run the reaction again:

```ts
reaction(
	() => foo(),
	() => foo(foo() + 1)
);
```

The example above will trigger circular reaction error after 100 cycles.

---

No matter if error happens in reaction, action, or effect, the state will continue functioning and be reactive. Reaction that threw the error won't cancel current effects queue, and will continue to be reactive until disposed manually, providing error recovery.
