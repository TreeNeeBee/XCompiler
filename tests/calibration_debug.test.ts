import { describe, it, expect } from 'vitest';
import {
  calibrateDebugSuggestions,
  renderDebugSuggestions,
} from '../src/agents/calibration.js';

describe('calibrateDebugSuggestions', () => {
  it('emits ModuleNotFoundError hint with list_dir / code_search guidance', () => {
    const sugs = calibrateDebugSuggestions(
      `Traceback (most recent call last):\n` +
        `  File "tests/test_foo.py", line 3, in <module>\n` +
        `    from src.dbc_parser import parse_dbc\n` +
        `ModuleNotFoundError: No module named 'src.dbc_parser'`,
      'pytest exit=2',
    );
    const codes = sugs.map((s) => s.code);
    expect(codes).toContain('ModuleNotFoundError');
    const m = sugs.find((s) => s.code === 'ModuleNotFoundError')!;
    expect(m.hint).toMatch(/list_dir/);
    expect(m.hint).toMatch(/code_search/);
    expect(m.hint).toMatch(/绝不要/); // 拒绝 no-op replace
  });

  it('detects "python tests/X.py" direct-script ModuleNotFoundError and points to pytest / sys.path', () => {
    const log =
      `Traceback (most recent call last):\n` +
      `  File "/tmp/dbc2excel/tests/test_dbc_parser.py", line 5, in <module>\n` +
      `    from dbc_parser import parse_dbc\n` +
      `ModuleNotFoundError: No module named 'dbc_parser'`;
    const sugs = calibrateDebugSuggestions(log);
    const direct = sugs.find((s) => s.code === 'ModuleNotFoundError-direct-script');
    expect(direct).toBeTruthy();
    expect(direct!.hint).toMatch(/run_tests/);
    expect(direct!.hint).toMatch(/conftest\.py/);
    expect(direct!.hint).toMatch(/sys\.path\.insert/);
    expect(direct!.hint).toMatch(/严禁/); // 不允许改成 from src.X
  });

  it('detects test fixture FileNotFoundError and recommends tmp_path / fixtures dir', () => {
    const log =
      `tests/test_dbc_parser.py:12: in test_parse\n` +
      `    result = parse_dbc('test.dbc')\n` +
      `src/dbc_parser.py:8: in parse_dbc\n` +
      `    with open(filename, encoding=encoding, errors='replace') as fin:\n` +
      `E           FileNotFoundError: [Errno 2] No such file or directory: 'test.dbc'`;
    const sugs = calibrateDebugSuggestions(log);
    const fix = sugs.find((s) => s.code === 'FileNotFoundError-test-fixture');
    expect(fix).toBeTruthy();
    expect(fix!.hint).toMatch(/tmp_path/);
    expect(fix!.hint).toMatch(/tests\/fixtures/);
    expect(fix!.hint).toMatch(/test\.dbc/);
    // 通用 FileNotFoundError 也会命中，但 fixture 规则 severity=1 排在前面
    expect(sugs[0].code).toBe('FileNotFoundError-test-fixture');
  });

  it('detects malformed fixture content (Invalid syntax at line N) and points to read+rewrite', () => {
    const log =
      `tests/test_dbc_parser.py::test_parse FAILED\n` +
      `tests/test_dbc_parser.py:14: in test_parse\n` +
      `    db = parse_dbc('tests/fixtures/sample.dbc')\n` +
      `src/dbc_parser.py:42: in parse_dbc\n` +
      `    raise ParseError(f"Invalid syntax at line {n}, column 1: \\\"{line}\\\"")\n` +
      `E   dbc_parser.ParseError: Invalid syntax at line 5, column 1: "BO_X"`;
    const sugs = calibrateDebugSuggestions(log);
    const fix = sugs.find((s) => s.code === 'fixture-content-malformed');
    expect(fix).toBeTruthy();
    expect(fix!.hint).toMatch(/read_file/);
    expect(fix!.hint).toMatch(/write_file/);
    expect(fix!.hint).toMatch(/整文件重写/);
    expect(fix!.hint).toMatch(/严禁/); // 别去改被测模块
    expect(fix!.hint).toMatch(/line 5/); // line 号回填到提示
    // 排序：fixture-malformed severity=1 必须在第一位（不被通用规则挤到后面）
    expect(sugs[0].code).toBe('fixture-content-malformed');
  });

  it('also detects "failed to parse" / ParseError style errors as fixture-content-malformed', () => {
    const sugs = calibrateDebugSuggestions(
      `E   ValueError: failed to parse JSON at offset 12: unexpected token`,
    );
    expect(sugs.find((s) => s.code === 'fixture-content-malformed')).toBeTruthy();
  });

  it('detects pytest collection failure (exit=2) even without traceback body', () => {
    const sugs = calibrateDebugSuggestions('', 'pytest exit=2');
    expect(sugs.find((s) => s.code === 'pytest-collection')).toBeTruthy();
  });

  it('flags forbidden "from src.X import" pattern', () => {
    const sugs = calibrateDebugSuggestions(
      `from src.data_processor import process_dbc_data`,
    );
    expect(sugs.find((s) => s.code === 'src-prefix-import')).toBeTruthy();
  });

  it('detects pip resolver failure and points to add_dependency mapping', () => {
    const sugs = calibrateDebugSuggestions(
      `ERROR: Could not find a version that satisfies the requirement pydbc`,
    );
    const m = sugs.find((s) => s.code === 'pip-resolver')!;
    expect(m).toBeTruthy();
    expect(m.hint).toMatch(/cantools|scikit-learn|opencv-python/);
  });

  it('catches replace_in_file no-op self-feedback', () => {
    const sugs = calibrateDebugSuggestions(
      `tool calls:\n  - replace_in_file FAIL no-op edit refused: find === replace`,
    );
    expect(sugs.find((s) => s.code === 'replace-no-op')).toBeTruthy();
  });

  it('returns empty when log is blank', () => {
    expect(calibrateDebugSuggestions('', '')).toEqual([]);
  });

  it('renderDebugSuggestions produces numbered markdown with evidence', () => {
    const sugs = calibrateDebugSuggestions(
      `ModuleNotFoundError: No module named 'foo'`,
    );
    const md = renderDebugSuggestions(sugs);
    expect(md).toMatch(/^## 修复建议/);
    expect(md).toMatch(/1\. /);
    expect(md).toMatch(/证据:/);
  });

  it('caps result to 6 suggestions', () => {
    const big = [
      `ModuleNotFoundError: No module named 'a'`,
      `ImportError: cannot import name 'X' from 'a'`,
      `ERROR collecting`,
      `from src.b import c`,
      `NameError: name 'd' is not defined`,
      `AttributeError: 'E' object has no attribute 'f'`,
      `TypeError: g() missing 1 required positional argument: 'h'`,
      `SyntaxError: invalid syntax`,
      `FileNotFoundError: [Errno 2] No such file: 'i.txt'`,
      `ERROR: No matching distribution found for j`,
      `UnicodeDecodeError: 'utf-8' codec can't decode byte`,
    ].join('\n');
    expect(calibrateDebugSuggestions(big).length).toBeLessThanOrEqual(6);
  });
});
