import {
  datasetFromRows,
  tableType,
  type CallContext,
  type Dataset,
  type FieldType,
  type Row,
  type TypeAnnotations,
} from "@prismengine/contracts-data";

const DEFAULT_TEST_PRINCIPAL = Object.freeze({
  id: "test-principal",
  displayName: "Test Principal",
  roles: Object.freeze(["test"]),
});

/** Deterministic capability-call context for tests. */
export function testCallContext(overrides: Partial<CallContext> = {}): CallContext {
  return {
    principal: DEFAULT_TEST_PRINCIPAL,
    asOf: { validAt: "2025-01-15" },
    correlationId: "prism-test",
    ...overrides,
  };
}

/** Builds a re-iterable Dataset and its TableType from one column declaration. */
export function testDataset(
  name: string,
  columns: readonly FieldType[],
  rows: readonly Row[],
): Dataset {
  return datasetFromRows(name, tableType(columns), rows);
}

export interface DecimalColumnOptions {
  readonly precision?: number;
  readonly scale?: number;
  readonly nullable?: boolean;
  readonly annotations?: TypeAnnotations;
}

/** Declares the common decimal test column without omitting precision or scale. */
export function decimalColumn(name: string, options: DecimalColumnOptions = {}): FieldType {
  const { precision = 28, scale = 6, nullable, annotations } = options;
  return {
    name,
    type: {
      kind: "decimal",
      precision,
      scale,
      ...(nullable === undefined ? {} : { nullable }),
      ...(annotations === undefined ? {} : { annotations }),
    },
  };
}

export type TestPersonName = "张三" | "李四" | "王五";

export interface TestPersonFixture {
  readonly employeeNumber: string;
  readonly displayName: TestPersonName;
  readonly title: string;
}

const PEOPLE = Object.freeze({
  张三: Object.freeze({
    employeeNumber: "001",
    displayName: "张三",
    title: "主任医师",
  }),
  李四: Object.freeze({
    employeeNumber: "002",
    displayName: "李四",
    title: "副主任医师",
  }),
  王五: Object.freeze({
    employeeNumber: "003",
    displayName: "王五",
    title: "医师",
  }),
} satisfies Readonly<Record<TestPersonName, TestPersonFixture>>);

/** Builds one of the three people shared by organization/performance suites. */
export function testPerson(
  name: TestPersonName,
  overrides: Partial<Omit<TestPersonFixture, "displayName">> = {},
): TestPersonFixture {
  return { ...PEOPLE[name], ...overrides };
}

/** Builds the recurring 张三 / 李四 / 王五 trio in stable order. */
export function testPeople(): readonly TestPersonFixture[] {
  return [testPerson("张三"), testPerson("李四"), testPerson("王五")];
}
