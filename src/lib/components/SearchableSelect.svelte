<script module lang="ts">
	export type SearchableSelectOption = {
		id: number;
		label: string;
	};
</script>

<script lang="ts">
	import { ChevronDown, Search, X } from '@lucide/svelte';
	import { defaultLocale, translate } from '$lib/i18n';

	type Props = {
		id: string;
		name: string;
		label: string;
		options: SearchableSelectOption[];
		selectedId?: number | null;
		selectedLabel?: string | null;
		placeholder?: string;
		empty?: string;
		wrapperClass?: string;
		locale?: string;
	};

	let {
		id,
		name,
		label,
		options,
		selectedId = null,
		selectedLabel = null,
		placeholder = 'Search',
		empty = 'No results',
		wrapperClass = '',
		locale = defaultLocale
	}: Props = $props();

	let root: HTMLDivElement | undefined = $state();
	let input: HTMLInputElement | undefined = $state();
	let open = $state(false);
	let inputValue = $state('');
	let selectedValue = $state('');
	let activeIndex = $state(0);
	let appliedExternalKey = $state('');

	const listboxId = $derived(`${id}-listbox`);
	const externalKey = $derived(
		[
			selectedId ?? '',
			selectedLabel ?? '',
			options.map((option) => `${option.id}:${option.label}`).join('|')
		].join('::')
	);
	const normalizedQuery = $derived(normalize(inputValue));
	const selectedOption = $derived(
		options.find((option) => String(option.id) === selectedValue) ?? null
	);
	const filteredOptions = $derived.by(() => {
		if (!normalizedQuery) return options;
		return options.filter((option) => normalize(option.label).includes(normalizedQuery));
	});
	const activeOption = $derived(filteredOptions[activeIndex] ?? null);
	const comboboxClass = $derived(
		`searchable-select${wrapperClass ? ` ${wrapperClass}` : ''}${open ? ' is-open' : ''}`
	);

	$effect(() => {
		if (externalKey === appliedExternalKey) return;
		selectedValue = selectedId ? String(selectedId) : '';
		inputValue = currentSelectedLabel();
		activeIndex = 0;
		open = false;
		appliedExternalKey = externalKey;
	});

	function normalize(value: string) {
		return value.trim().toLocaleLowerCase(locale);
	}

	function currentSelectedLabel() {
		const selected = selectedId ? options.find((option) => option.id === selectedId) : null;
		return selected?.label ?? selectedLabel ?? '';
	}

	function choose(option: SearchableSelectOption) {
		selectedValue = String(option.id);
		inputValue = option.label;
		activeIndex = 0;
		open = false;
		input?.focus();
	}

	function clearSelection() {
		selectedValue = '';
		inputValue = '';
		activeIndex = 0;
		open = false;
		input?.focus();
	}

	function handleInput(event: Event) {
		inputValue = (event.currentTarget as HTMLInputElement).value;
		if (selectedOption?.label !== inputValue) selectedValue = '';
		activeIndex = 0;
		open = true;
	}

	function handleFocusOut(event: FocusEvent) {
		const next = event.relatedTarget;
		if (next instanceof Node && root?.contains(next)) return;
		commitOrReset();
		open = false;
	}

	function commitOrReset() {
		if (!inputValue.trim()) {
			selectedValue = '';
			inputValue = '';
			return;
		}

		const exact = options.find((option) => normalize(option.label) === normalize(inputValue));
		if (exact) {
			selectedValue = String(exact.id);
			inputValue = exact.label;
			return;
		}

		inputValue = selectedOption?.label ?? '';
	}

	function moveActive(delta: number) {
		if (filteredOptions.length === 0) return;
		open = true;
		activeIndex = (activeIndex + delta + filteredOptions.length) % filteredOptions.length;
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			moveActive(1);
			return;
		}

		if (event.key === 'ArrowUp') {
			event.preventDefault();
			moveActive(-1);
			return;
		}

		if (event.key === 'Enter' && open && activeOption) {
			event.preventDefault();
			choose(activeOption);
			return;
		}

		if (event.key === 'Escape') {
			event.preventDefault();
			commitOrReset();
			open = false;
		}
	}
</script>

<div bind:this={root} class={comboboxClass} onfocusout={handleFocusOut}>
	<label for={id}>
		<span>{label}</span>
	</label>
	<div class="searchable-select-control">
		<Search class="searchable-select-search-icon" size={16} aria-hidden="true" />
		<input
			bind:this={input}
			{id}
			class="searchable-select-input"
			type="text"
			role="combobox"
			aria-label={label}
			aria-controls={listboxId}
			aria-expanded={open}
			aria-autocomplete="list"
			aria-haspopup="listbox"
			aria-activedescendant={activeOption ? `${listboxId}-${activeOption.id}` : undefined}
			autocomplete="off"
			inputmode="search"
			{placeholder}
			value={inputValue}
			onfocus={() => (open = true)}
			onclick={() => (open = true)}
			oninput={handleInput}
			onkeydown={handleKeydown}
		/>
		<input type="hidden" {name} value={selectedValue} />
		<div class="searchable-select-actions">
			{#if selectedValue || inputValue}
				<button
					class="searchable-select-clear"
					type="button"
					aria-label={translate(locale, 'Clear {label}', { label })}
					onclick={clearSelection}
				>
					<X size={15} />
				</button>
			{/if}
			<button
				class="searchable-select-toggle"
				type="button"
				aria-label={translate(locale, 'Open {label}', { label })}
				onclick={() => {
					open = !open;
					input?.focus();
				}}
			>
				<ChevronDown size={16} />
			</button>
		</div>
	</div>

	{#if open}
		<div class="searchable-select-list" id={listboxId} role="listbox" aria-label={label}>
			{#each filteredOptions as option, index (option.id)}
				<button
					id={`${listboxId}-${option.id}`}
					class={`searchable-select-option${activeOption?.id === option.id ? ' active' : ''}`}
					type="button"
					role="option"
					aria-selected={selectedValue === String(option.id)}
					onmousedown={(event) => event.preventDefault()}
					onmouseenter={() => (activeIndex = index)}
					onclick={() => choose(option)}
				>
					{option.label}
				</button>
			{:else}
				<span class="searchable-select-empty">{empty}</span>
			{/each}
		</div>
	{/if}
</div>
