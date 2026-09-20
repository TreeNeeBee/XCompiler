import type { Language } from './execution_plan.js';

export interface LanguageContract {
  readonly id: Language;
  readonly displayName: string;
  readonly manifestFile: string;
  readonly codeExtensions: readonly string[];
  readonly seedManifestFromDeps: boolean;
  readonly manifestContract?: {
    readonly testScript?: string;
  };
  testFileFor(srcOutput: string | undefined, stepId: string): string;
}

const PYTHON_TEST_SOURCE = /\.py$/u;

const PYTHON_CONTRACT: LanguageContract = {
  id: 'python',
  displayName: 'Python',
  manifestFile: 'requirements.txt',
  codeExtensions: ['.py'],
  seedManifestFromDeps: true,
  testFileFor(srcOutput, stepId) {
    if (srcOutput?.startsWith('src/') && PYTHON_TEST_SOURCE.test(srcOutput)) {
      const base = srcOutput.replace(/^src\//u, '').replace(/\.py$/u, '').replaceAll('/', '_');
      return `tests/test_${base}.py`;
    }
    return `tests/test_${stepId.toLowerCase()}.py`;
  },
};

const TYPESCRIPT_CONTRACT: LanguageContract = {
  id: 'typescript',
  displayName: 'TypeScript',
  manifestFile: 'package.json',
  codeExtensions: ['.ts', '.tsx'],
  seedManifestFromDeps: false,
  manifestContract: { testScript: 'vitest run' },
  testFileFor(srcOutput, stepId) {
    if (srcOutput?.startsWith('src/') && /\.tsx?$/u.test(srcOutput)) {
      const base = srcOutput.replace(/^src\//u, '').replace(/\.tsx?$/u, '').replaceAll('/', '_');
      return `tests/${base}.test.ts`;
    }
    return `tests/${stepId.toLowerCase()}.test.ts`;
  },
};

const LANGUAGE_CONTRACTS: Readonly<Record<Language, LanguageContract>> = {
  python: PYTHON_CONTRACT,
  typescript: TYPESCRIPT_CONTRACT,
};

export function getLanguageContract(language: Language): LanguageContract {
  return LANGUAGE_CONTRACTS[language] ?? PYTHON_CONTRACT;
}
