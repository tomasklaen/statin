const IS_COMPUTED = Symbol('computed');
const IS_STATIN_ERROR = Symbol('statin_error');
const observersStack: Observer[] = [];
const dependencyMap = new WeakMap<Observer, Set<Dependency>>();
const observerMap = new WeakMap<Dependency, Set<Observer>>();
const nameCounters: {[key: string]: number} = {};
let effectQueue: Set<Observer> | null = null;
let doNotTrack = false;
let disallowWrites = false;
let currentEffect: (() => void) | undefined;

/**
 * Reaction depth is a map keeping track of how many times was the reaction
 * executed within the same action. Used to detect circular reactions.
 */
const reactionsDepthMap: Map<Observer, number> = new Map();
const MAX_REACTION_DEPTH = 100;

/**
 * Types.
 */

type Observer = () => void;
type Dependency = Signal<unknown> | Observer;

export type Disposer = () => void;
export type Action<T extends unknown> = (dispose: Disposer) => T;

export interface Signal<T extends unknown = unknown> {
	/** Read value. */
	(): T;
	/** Read value. */
	get: () => T;
	r: () => T;
	/** Set value. */
	(value: T): void;
	/** Set value. */
	set: (value: T) => void;
	w: (value: T) => void;
	/** Non-reactive reference to value. */
	value: T;
	/** Manually triggers value change signal. */
	changed: () => void;
	/**
	 * Edit mutable signal value.
	 *
	 * When editor function finishes, change signal will be sent for the current value.
	 *
	 * Return value is ignored.
	 */
	edit: (editor: (value: T) => void) => void;
	toJSON: () => T;
	/**
	 * It's common to forget `()` and do `signal.length` to check arrays, which
	 * usually doesn't get caught because `function.length` is also a number.
	 * By setting this to `unknown` we get TypeScript to complain.
	 */
	length: unknown;
}

export interface Computed<T extends unknown> {
	/** Read value. */
	(): T;
	toJSON: () => T;
	/** See `Signal.length` comment. */
	length: unknown;
}

export type ReactionAction<T extends unknown> = (dispose: Disposer) => T;
export type ReactionEffect<T extends unknown> = (value: T, dispose: Disposer) => void;
export type OnceAction = (dispose: Disposer) => void;
export type OnceEffect = () => void;

export interface OnceOptions {
	onError?: (error: Error, dispose: Disposer) => void;
}

export interface ReactionOptions extends OnceOptions {
	immediate?: boolean;
}

export class CircularReactionError extends Error {
	[IS_STATIN_ERROR]: true;

	constructor(message: string) {
		super(message);
		this[IS_STATIN_ERROR] = true; // Why do I have to do this?
	}
}

type NamedFunction = ((...args: any[]) => void) & {displayName?: string};

/**
 * Names a function.
 */
export function nameFn<T extends (...args: any[]) => void>(name: string, fn: T): T & {displayName: string} {
	(fn as any).displayName = name;
	return fn as any;
}

/**
 * Retrieves function name.
 */
export function fnName(fn: NamedFunction | undefined | null, fallbackName: string = 'Unknown') {
	return (
		(fn && (fn.displayName || fn.name)) ||
		`${fallbackName}${nameCounters[fallbackName] ? nameCounters[fallbackName]++ : (nameCounters[fallbackName] = 0)}`
	);
}

/**
 * Checks if observer is a computed value.
 */
const isComputed = (value: Exclude<any, undefined | null>) => value[IS_COMPUTED] === true;

/**
 * Describes an error by pre-pending its source to the message, and marks it as
 * described.
 */
function describeError(maybeError: unknown, source: string): Error {
	if ((maybeError as any)?.[IS_STATIN_ERROR]) return maybeError as Error;
	const error: any = maybeError instanceof Error ? maybeError : new Error(`${maybeError}`);
	error.message = `Error in ${source}: ${error.message}`;
	error[IS_STATIN_ERROR] = true;
	return error;
}

/**
 * Registers a dependency to the currently active observer.
 */
function registerDependency(dependency: Dependency) {
	const observer = observersStack[observersStack.length - 1];
	if (!observer || doNotTrack) return;

	// Add observer to dependency's observers
	let observersSet = observerMap.get(dependency);

	if (!observersSet) {
		observersSet = new Set<Observer>();
		observerMap.set(dependency, observersSet);
	}

	observersSet.add(observer);

	// Add dependency to observer's dependencies
	let dependencySet = dependencyMap.get(observer);

	if (!dependencySet) {
		dependencySet = new Set<Signal<any>>();
		dependencyMap.set(observer, dependencySet);
	}

	dependencySet.add(dependency);
}

/**
 * Clears passed observer's dependencies.
 */
function clearDependencies(observer: Observer) {
	let dependencySet = dependencyMap.get(observer);

	if (!dependencySet) return;

	for (let dependency of dependencySet) {
		const trackersSet = observerMap.get(dependency);
		if (trackersSet) {
			trackersSet.delete(observer);
			// Is this necessary when we are using WeakMap?
			if (trackersSet.size === 0) observerMap.delete(dependency);
		}
	}

	dependencyMap.delete(observer);
}

/**
 * Call all dependency observers.
 */
function triggerObservers(dependency: Dependency) {
	const observersSet = observerMap.get(dependency);
	const currentObserver = observersStack[observersStack.length - 1];

	if (observersSet) {
		// Reactions would repopulate observersSet as we are iterating through
		// it, so we need to make a copy here.
		for (let observer of [...observersSet]) {
			// Do not re-trigger current observer
			if (observer === currentObserver) continue;

			// When effectQueue is active, delay observer triggering to its end.
			// Let computed values pass through to the try/catch so that they
			// trigger they correctly propagate changes to their observers.
			if (effectQueue && !isComputed(observer)) {
				effectQueue.add(observer);
			} else {
				observer();
			}
		}
	}
}

/**
 * Resumes tracking paused by `action()` for the duration of `fn()`.
 */
function resumeTrackingWhile(fn: () => void) {
	let parentDoNotTrack = doNotTrack;
	doNotTrack = false;
	try {
		fn();
	} finally {
		doNotTrack = parentDoNotTrack;
	}
}

/**
 * Value to JSON helper.
 */
export function toJSON(value: any): any {
	return value?.toJSON ? value.toJSON() : value;
}

/**
 * Converts everything statin related into raw JS values.
 *
 * This obviously trades speed for implementation size, but it's still fast
 * enough for all practical purposes. It's hard to imagine a use case where this
 * would cause performance degradation. If you need to serialize 1000s of times
 * a second, you need an alternative implementation.
 */
export function toJS(value: any) {
	const stringified = JSON.stringify(value);
	return stringified == null ? stringified : JSON.parse(stringified);
}

/**
 * Helper function to either handle error with onError event, or log it to console.
 * ALso ensures onError handler won't throw by capturing and logging its error as well.
 */
function handleOrLog(error: Error, onError: ((error: Error) => void) | undefined) {
	try {
		if (onError) onError(error as Error);
		else throw error;
	} catch (error) {
		console.error(error);
	}
}

/**
 * Creates a signal that will trigger its observers any time a new value is
 * assigned to it.
 *
 * ```ts
 * const foo = signal('bar'); // inferred string
 * // or strongly typed
 * const foo = signal<'bar' | 'baz'>('bar');
 * foo();      // read `foo`, returns 'bar'
 * foo('baz'); // sets `foo` to 'baz', and signals its observers
 * ```
 *
 * If signal holds an object you want to mutate, use `foo.edit(value => { ...mutations... })`:
 *
 * ```ts
 * const set = signal(new Set<string>());
 * set.edit(set => set.add('foo'));
 * ```
 *
 * Note: `signal.edit(editor)` ignores value returned by editor, it assumes mutation is happening.
 */
export function signal<T extends unknown>(value: T): Signal<T> {
	function getSet(): T;
	function getSet(value: T): void;
	function getSet(value?: T) {
		return arguments.length ? getSet.w(value!) : getSet.r();
	}

	getSet.value = value;
	getSet.get = getSet.r = () => {
		registerDependency(getSet);
		return getSet.value;
	};
	getSet.set = getSet.w = (value: T) => {
		if (disallowWrites) throw new Error(`Writing to signals not allowed in this context.`);
		if (value !== getSet.value) {
			getSet.value = value;
			getSet.changed();
		}
	};
	getSet.changed = () => {
		if (!effectQueue) bulkEffects(() => triggerObservers(getSet));
		else triggerObservers(getSet);
	};
	getSet.edit = (editor: (value: T) => void) => {
		editor(getSet.value);
		getSet.changed();
	};
	getSet.toJSON = () => toJSON(getSet.r());

	return getSet;
}

/**
 * Allows expensive computation to be cached until any of its dependencies
 * changes.
 *
 * Also acts as a signal to any parent observer.
 *
 * ```ts
 * const n = signal(5);
 * const nFactorial = computed(() => factorial(n()));
 * nFactorial(); // 1st computation of `factorial(5)`
 * nFactorial(); // returns cached result from 1st
 * n(6);
 * nFactorial(); // 2nd computation of `factorial(6)`
 * ```
 */
export function computed<T extends unknown>(compute: (prev: T | undefined) => T): Computed<T> {
	const name = fnName(compute, 'Computed');
	let value: T | undefined;
	let hasChanges = true;
	let hasError = false;
	let error: unknown;

	function computedObserver() {
		hasError = false;
		error = undefined;
		hasChanges = true;
		clearDependencies(computedObserver);
		triggerObservers(computedObserver);
	}
	computedObserver.displayName = name;
	computedObserver[IS_COMPUTED] = true as const;

	function get() {
		registerDependency(computedObserver);

		if (hasChanges) {
			observersStack.push(computedObserver);
			disallowWrites = true;

			try {
				hasError = false;
				error = undefined;
				resumeTrackingWhile(() => (value = compute(value)));
			} catch (error_) {
				hasError = true;
				error = describeError(error_, name);
			} finally {
				disallowWrites = false;
				hasChanges = false;
				observersStack.pop();
			}
		}

		if (hasError) throw error;

		return value!;
	}
	get.toJSON = () => toJSON(get());

	return get as Computed<T>;
}

/**
 * Queues all observers of signals used in `effect()` to be notified after
 * the action is finished, and handles resulting cascade of effects.
 */
function bulkEffects<T extends unknown>(effect: () => T, {onError}: {onError?: (error: Error) => void} = {}): T {
	// Being already inside a parent effect queue requires adjusting behavior
	let isRootEffect = false;
	if (effectQueue == null) {
		isRootEffect = true;
		effectQueue = new Set();
		reactionsDepthMap.clear();
	}

	let result;
	const parentEffect = currentEffect;
	currentEffect = effect;

	try {
		result = effect();
	} catch (error) {
		error = describeError(error, fnName(currentEffect));
		if (onError) onError(error as Error);
		else console.error(error);
	} finally {
		if (isRootEffect) {
			// We bulk & execute effects of effects until there are no effects left
			while (effectQueue.size > 0) {
				const effects = effectQueue;
				effectQueue = new Set();
				// Effects of effects can only be computed, reaction, or once
				// observers, which all have their own error handling, but their
				// onError handlers provided by users might still throw.
				for (let effect of effects) effect();
			}

			reactionsDepthMap.clear();
			effectQueue = null;
		}

		currentEffect = parentEffect;
	}

	return result as T;
}

/**
 * Queues all observers of signals used in `run()` to be executed after
 * the action is finished.
 *
 * ```ts
 * const value = signal('init');
 * reaction(() => console.log(value())); // console.log: 'init'
 *
 * value('foo'); // console.log: 'foo'
 * value('bar'); // console.log: 'bar'
 *
 * action(() => {
 *   value('foo');
 *   value('bar');
 * });
 * // console.log: 'bar'
 * ```
 */
export function action<T extends unknown>(fn: () => T): T {
	const parentDoNotTrack = doNotTrack;
	doNotTrack = true;
	try {
		return bulkEffects(nameFn(fnName(fn, 'Action'), fn), {
			onError: (error) => {
				throw error;
			},
		});
	} finally {
		doNotTrack = parentDoNotTrack;
	}
}

/**
 * Wraps common methods in an action.
 *
 * ```ts
 * const something = (foo: string) => {};
 * const doSomething = createAction(something);
 * // which is just a typed shorthand for
 * const doSomething = (...args: any[]) => action(() => something(...args));
 * ```
 */
// export function createAction<T extends unknown, Args extends any[] = any[]>(run: (...args: Args) => T) {
export function createAction<T extends unknown, Args extends any[]>(run: (...args: Args) => T) {
	return (...args: Args) => action<T>(() => run(...args));
}

/**
 * Will execute `action()` on init, and any time any of its dependencies changes.
 *
 * Returns disposer function. `action()` also receives disposer as 1st argument.
 *
 * ```ts
 * const dispose = reaction((dispose) => {
 *   // ...do something...
 *   dispose(); // dispose internally
 * });
 *
 * dispose(); // dispose externally
 * ```
 *
 * You can also pass an effect that should run when dependencies change. The
 * `effect()` function receives the value returned by `action()` as 1st
 * argument, and disposer as 2nd.
 *
 * ```ts
 * const dispose = reaction(
 *   () => `${foo()} ${bar()}`,
 *   (foobar, dispose) => {
 *     console.log(foobar);
 *     dispose();
 *   }
 * );
 * ```
 *
 * Options:
 *
 * ```ts
 * const options = {
 *   immediate: true, // trigger `effect()` also on reaction initialization
 *   onError: (error) => {} // handle errors that happen in either action or effect
 * }
 * reaction(action, effect, options);
 * ```
 */
export function reaction<T extends unknown>(action: ReactionAction<T>, options?: ReactionOptions): Disposer;
export function reaction<T extends unknown>(
	action: ReactionAction<T>,
	effect: ReactionEffect<T>,
	options?: ReactionOptions
): Disposer;
export function reaction<T extends unknown>(
	action: ReactionAction<T>,
	effectOrOptions?: ReactionEffect<T> | ReactionOptions,
	options?: ReactionOptions
): Disposer {
	let value: any;
	let onceDisposer: Disposer | undefined;
	let effect: ReactionEffect<T> | undefined;
	if (typeof effectOrOptions === 'function') {
		effect = effectOrOptions;
	} else {
		options = effectOrOptions;
	}
	const {immediate, onError} = options || {};
	const actionName = fnName(action, effect ? 'ReactionAction' : 'Reaction');
	const effectName = fnName(effect, 'ReactionEffect');
	const actionWrap = nameFn(actionName, (dispose: Disposer) => {
		value = action(dispose);
	});
	const effectWrap = nameFn(effectName, () => {
		try {
			effect?.(value, dispose);
		} catch (error) {
			handleError(describeError(error, effectName));
		}
	});
	const onceEffect = nameFn(effectName, () => {
		// Detect circular reactions
		const stackSize = reactionsDepthMap.get(onceEffect) || 0;

		if (stackSize > MAX_REACTION_DEPTH) {
			throw new CircularReactionError(
				`Circular reaction in ${actionName}${effect ? `->${effectName}` : ''}:\n---\n${(
					effect || action
				).toString()}\n---`
			);
		}

		reactionsDepthMap.set(onceEffect, stackSize + 1);

		// Recompute the new value and re-subscribe
		createOnceLoop();

		// Trigger effect
		effectWrap();
	});

	function dispose() {
		onceDisposer?.();
	}

	function handleError(error: Error) {
		handleOrLog(error, onError ? (error) => onError(error, dispose) : undefined);
	}

	function createOnceLoop() {
		onceDisposer = once(actionWrap, onceEffect, {
			onError: (error, dispose) => {
				onceDisposer = dispose;
				handleError(error);
			},
		});
	}

	// Start the chain
	createOnceLoop();

	// Immediate effect call
	if (immediate) effectWrap();

	return dispose;
}

/**
 * Triggers `action()` to find its dependencies, and fires `effect()` when
 * any of them changes, than forgets about everything.
 */
export function once(observe: OnceAction, effect: OnceEffect, {onError}: OnceOptions = {}): Disposer {
	const dispose = () => clearDependencies(observer);
	const observerName = fnName(observe, 'OnceObserver');
	const effectName = fnName(effect, 'OnceEffect');
	const errorHandler = onError ? (error: Error) => onError(error, dispose) : undefined;
	const observer = nameFn(observerName, () => {
		dispose();
		bulkEffects(effect, {onError: (error) => handleOrLog(describeError(error, effectName), errorHandler)});
	});

	observersStack.push(observer);

	try {
		let internalDisposerCalled = false;
		const internalDisposer = () => (internalDisposerCalled = true);
		resumeTrackingWhile(() => observe(internalDisposer));
		if (internalDisposerCalled) dispose();
	} catch (error) {
		handleOrLog(describeError(error, observerName), errorHandler);
	} finally {
		observersStack.pop();
	}

	return dispose;
}
