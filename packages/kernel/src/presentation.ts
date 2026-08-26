/**
 * Presentation is a one-way projection: it may describe how a configuration
 * contract is displayed, and may never change its semantics.
 *
 * Dependency direction, enforced by architecture tests:
 *   presentation -> configuration contract -> capability -> engine
 */

export interface FieldPresentation {
  /** Business-facing label, e.g. "金额舍入". */
  readonly label?: string;
  readonly help?: string;
  readonly placeholder?: string;
  /** Group id declared in `PresentationSpec.groups`. */
  readonly group?: string;
  readonly order?: number;
  /** Widget hint. Falls back to the generic renderer's type mapping. */
  readonly widget?: string;
  /** Registered custom editor id, e.g. "prism.expression". */
  readonly editor?: string;
  readonly hidden?: boolean;
  readonly readonly?: boolean;
  readonly editorOptions?: Readonly<Record<string, unknown>>;
}

export interface PresentationGroup {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly order?: number;
  readonly collapsed?: boolean;
}

export interface PresentationSpec {
  readonly title?: string;
  readonly description?: string;
  readonly icon?: string;
  readonly groups?: readonly PresentationGroup[];
  /** Keyed by JSON pointer-ish field path, e.g. "rounding.mode". */
  readonly fields?: Readonly<Record<string, FieldPresentation>>;
  /** Custom editor for the whole resource, bypassing the generic form. */
  readonly editor?: string;
}
