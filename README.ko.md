# vanilla-build

일반 웹 프로젝트용 빌드 도구입니다. 하는 일은 다음과 같습니다.

- ES 모듈과 CommonJS를 `esm` / `iife` / `cjs` 파일 하나로 번들링합니다.
- JavaScript와 CSS를 압축합니다.
- 에셋 이름에 콘텐츠 해시를 붙이고 `manifest.json`을 씁니다.
- HTML 페이지가 결과물을 가리키도록 고쳐 씁니다.
- TypeScript는 Node 자체의 타입 제거 기능으로 처리합니다.

[English README](README.md) · [변경 기록](CHANGELOG.md) · MIT License

- **의존성 0개.** `package.json`에는 `dependencies`도 `devDependencies`도 없습니다. 모든 것이 Node 표준
  라이브러리만으로 돌아갑니다.
- **직접 작성.** 파서, 스코프 분석, 번들러, CSS 도구, HTML 스캐너는 이 프로젝트를 위해 직접 작성했습니다.
  JavaScript 압축기는 같은 저자의 vanilla-kit에서 수정 없이 가져왔습니다([압축기](#압축기) 참고).
- **모든 보장은 테스트됩니다.** [보장 내용과 근거 테스트](#보장-내용과-근거-테스트)의 각 항목에는 그것을 확인하는
  테스트가 적혀 있습니다. 설명은 있지만 전용 테스트가 없는 동작은
  [설명만 있고 테스트는 없는 항목](#설명만-있고-테스트는-없는-항목)에 모아 두었습니다.

상태: **0.1.0**, 첫 릴리스입니다. Node 22 이상이 필요합니다. TypeScript에는 `module.stripTypeScriptTypes`가
필요합니다(Node 22.13+ / 23.2+). 테스트는 Node 26.13(Windows)에서 실행했습니다.

## 빠른 시작

npm에는 올라가 있지 않습니다. 이 저장소를 체크아웃해서 사용합니다.

```sh
node path/to/vanilla-build/bin/vanilla-build.mjs --help
# 또는 PATH에 vanilla-build 등록:
cd path/to/vanilla-build && npm link
```

포함된 예제를 빌드해 봅니다.

```sh
cd examples/site
node ../../bin/vanilla-build.mjs
```

예제에는 다음이 들어 있습니다.

- 다른 스타일시트를 `@import`하는 스타일시트
- 이미지 하나
- TypeScript 엔트리 모듈. 이 모듈은 TypeScript 모듈, JSON 모듈(`with { type: 'json' }`), CommonJS 모듈을
  import합니다.

빌드하면 `dist/`에 다음이 생깁니다.

- 해시가 붙은 파일들
- `integrity` 속성이 붙도록 고쳐 쓴 `index.html`
- `manifest.json`
- `public/robots.txt`

## 빌드 과정

1. `root` 아래의 모든 `.html`을 읽습니다. `html`에 목록을 주면 그 페이지만 읽습니다.
2. 페이지 안의 로컬 참조마다 작업이 하나씩 생깁니다.
   - `<script src>`는 번들링합니다. `type="module"`이면 `esm`, 일반 스크립트면 `iife`로 출력합니다.
   - `<link rel="stylesheet" href>`는 `@import`를 인라인한 뒤 압축합니다.
   - `<link rel="modulepreload" href>`는 `esm`으로 번들링합니다.
   - `<img src>`와 그 밖의 `<link href>`는 해시가 붙은 이름으로 복사합니다.
3. 출력은 소스 폴더 구조를 그대로 따르고, 이름은 `이름.<sha256 앞 8자리>.확장자`가 됩니다. 해시는 최종 바이트로
   계산합니다.
4. 페이지는 속성 값만 바꾸고, 나머지는 바이트 단위로 그대로 둡니다. `integrity`를 켜면 스크립트와 스타일시트에
   `integrity="sha384-…"`가 붙습니다.
5. `manifest.json`은 번들링한 스크립트, 스타일시트, 해시 에셋의 소스 경로(`root` 기준)를 출력 경로에
   대응시킵니다. 페이지와 그냥 복사한 파일은 들어가지 않습니다. 키는 정렬되어 있습니다.
6. `root` 아래의 나머지 파일은 그대로 복사합니다. 번들이나 스타일시트에 들어간 파일과 TypeScript 파일은 복사하지
   않습니다. 마지막으로 `publicDir`를 결과 위에 덮어 복사합니다.

## 설정 파일

`build` 명령은 `./vanilla-build.config.mjs`가 있으면 그 파일을, `--config`를 주면 지정한 파일을 읽습니다. default
export는 객체이거나, 객체를 돌려주는 함수(async 가능)입니다. 모든 키는 생략할 수 있고, 기본값은 다음과 같습니다.

```js
export default {
  root: '.',            // 소스 폴더
  outDir: 'dist',       // 출력 폴더. clean이 true면 먼저 비움
  html: null,           // 처리할 페이지(root 기준). null이면 root 아래 모든 .html
  entries: [],          // 페이지 없이 빌드할 스크립트: 'js/worker.js' 또는 { entry, format, name }
  minify: true,         // JS 번들과 CSS 압축
  hash: true,           // 콘텐츠 해시 파일 이름
  integrity: false,     // <script>와 스타일시트 <link>에 integrity="sha384-..." 추가
  clean: true,          // 빌드 전에 outDir 비우기
  publicDir: null,      // 결과 위에 그대로 복사할 폴더
  external: [],         // import / require로 남길 지정자(iife 출력은 globals 항목이 필요)
  globals: {},          // iife: external 지정자 -> 전역 변수 이름, 예: { react: 'React' }
  importMeta: 'error',  // 'keep'이면 esm 출력에 import.meta를 남김(번들 자신을 가리키게 됨)
};
```

무엇이든 비우기 전에, 다음과 같은 `outDir`는 거부합니다.

- 파일 시스템 루트
- 소스 루트이거나 소스 루트를 포함하는 폴더
- 작업 디렉터리이거나 작업 디렉터리를 포함하는 폴더
- 안에 `.git`이 있는 폴더

추가 엔트리(`entries`)의 해시 이름은 `manifest.json`에만 기록되고, 그 이름을 참조하도록 고쳐 주는 곳은 없습니다.

## CLI

```
vanilla-build [build] [options]            vanilla-build.config.mjs에 적힌 사이트 빌드
vanilla-build bundle <entry> [options]     엔트리 하나 번들링 (ESM / CommonJS / JSON / TypeScript)
vanilla-build minify <file.js> [options]   JavaScript 파일 하나 압축
vanilla-build css <file.css> [options]     스타일시트 하나의 @import 인라인 + 압축
```

| 명령 | 옵션 | 의미 |
|---|---|---|
| build | `--config <file>` | 설정 파일(기본: `./vanilla-build.config.mjs`가 있으면 그것) |
| | `--root <dir>` / `--out <dir>` / `--public <dir>` | `root`, `outDir`, `publicDir` 덮어쓰기 |
| | `--no-minify` `--no-hash` `--no-clean` `--integrity` | 같은 이름의 설정 키 덮어쓰기 |
| | `--watch` | `root` 아래 파일이 바뀌면 다시 빌드(디바운스). 출력 폴더는 무시 |
| bundle | `-o, --out <file>` | 출력 파일(기본: stdout) |
| | `--format <esm\|iife\|cjs>` | 출력 형식(기본 `esm`) |
| | `--name <Global>` | iife: 엔트리의 export를 이 전역 변수에 할당 |
| | `--external <a,b>` | 이 지정자들은 import / require로 남김 |
| | `--minify` | 번들 압축 |
| minify | `-o, --out <file>` `--no-mangle` `--keep-fnames` `--no-license` | 출력 파일 / 공백만 제거 / 함수 이름 유지 / 라이선스 주석 제거 |
| css | `-o, --out <file>` `--root <dir>` | 출력 파일 / 루트 기준 `@import "/x.css"`와 `url()` 재계산의 기준 폴더(기본: 파일이 있는 폴더) |
| 공통 | `-h, --help` `-v, --version` | |

- 명령줄 플래그가 설정 파일보다 우선합니다.
- 오류가 나면 한 줄 메시지를 내고 종료 코드 1로 끝납니다.
- 경고는 `build`에서는 stdout으로, `bundle`과 `css`에서는 stderr로 나갑니다.

## 프로그래밍 API

```js
import { build, watch, bundle, minify, minifyCss, inlineImports, stripTypes } from 'vanilla-build';

const r = await build({ root: 'src', outDir: 'dist', integrity: true });
// r: { outputs: [{ source, file, bytes, kind }], manifest, warnings, ms, outDir }

const w = watch({ root: 'src' }, { onBuild: (r) => {}, onError: (e) => {}, debounce: 100 });
w.close();

const b = bundle({ entry: 'src/main.ts', format: 'iife', name: 'App', root: 'src', external: [], globals: {} });
// b: { code, modules, exports, warnings }. 지원하지 않는 입력이면 BundleError(.file 포함)를 던짐

minify(code, { mangle: true, keepLicense: true, keepFnames: false, keepClassnames: true });  // -> { code, ... }
minifyCss(css);                                   // -> string
inlineImports('src/app.css', { root: 'src' });    // -> { css, files, warnings }
stripTypes(tsSource, 'file.ts');                  // -> 타입 자리를 공백으로 바꾼 JavaScript
```

그 밖에 다음도 export합니다.

- `loadConfig`, `checkOutDir`, `DEFAULTS`, `BundleError`
- `scanHtml`, `rewriteHtml`, `typeScriptAvailable`
- 하위 계층인 `parse`(소스 범위가 있는 ESTree 형태 AST)와 `analyze`(스코프 분석)

## 보장 내용과 근거 테스트

`npm test`(`node --test`)는 테스트 52개를 실행합니다.

| 파일 | 테스트 수 |
|---|---|
| `bundle.test.mjs` | 34 |
| `build.test.mjs` | 7 |
| `css.test.mjs` | 5 |
| `ts.test.mjs` | 3 |
| `html.test.mjs` | 2 |
| `examples.test.mjs` | 1 |

러너는 54개로 표시합니다. `test/` 아래의 픽스처 모듈과 헬퍼 모듈도 파일 단위로 하나씩 세기 때문입니다.

### 번들러: 네이티브 Node와의 차등 테스트

`test/bundle.test.mjs`는 29개 픽스처(`test/fixtures/bundle-cases.mjs`) 각각을 다음 순서로 확인합니다.

1. 픽스처를 임시 폴더에 씁니다.
2. 번들링하지 않은 ES 모듈 / CommonJS 그대로 **Node에서 실행**합니다.
3. 출력 형식마다 번들을 만들어 실행합니다.
4. **stdout, 종료 코드, 잡히지 않은 오류의 이름**이 네이티브 실행과 같아야 통과합니다.

- 22개 픽스처는 번들을 만들어 이렇게 비교합니다. 그중 18개는 세 형식 모두, 2개는 `esm`만(최상위 await), 2개는
  `iife` + `cjs`만(CommonJS 엔트리 하나, 그리고 strict인 `esm` 출력에 담을 수 없는 `with`를 쓰는 sloppy 코드)
  비교합니다.
- 7개는 정해진 메시지로 빌드가 실패해야 통과합니다. 네이티브에서도 실패하거나, 충실하게 번들링할 수 없는
  경우들입니다.

| 동작 | 픽스처 |
|---|---|
| ESM 평가 순서(후위 순회, 모듈마다 한 번) | `evaluation-order` |
| 라이브 바인딩: 모듈이 바꾼 export `let`을 import한 쪽에서 봄 | `live-bindings` |
| 순환 import: 함수 선언은 미리 사용 가능, `var`는 undefined, `let`/`const`/`class`는 TDZ `ReferenceError`(잡힌 경우와 안 잡힌 경우) | `circular-functions`, `circular-var`, `circular-tdz-caught`, `circular-tdz-uncaught` |
| `export *`, 재export 체인, default + named, 단축 속성과 구조 분해 | `export-star`, `reexport-chain`, `default-and-named`, `shorthand-and-patterns` |
| 네임스페이스 객체(`import * as ns`) | `namespace-object` |
| 겹치는 최상위 이름을 동작 변화 없이 이름 변경 | `name-collisions` |
| ES 모듈의 최상위 `this`와 strict 모드 | `top-level-this-and-strict` |
| 모듈을 이어 붙여도 ASI 문제 없음 | `asi-between-modules` |
| 정적으로도 import한 모듈의 `import()` | `dynamic-import`, `dynamic-import-in-function` |
| `with { type: 'json' }` JSON 모듈 | `json-import` |
| CommonJS 그래프, CommonJS를 import하는 ESM, iife/cjs에서 sloppy 유지 | `cjs-graph`, `esm-imports-cjs`, `cjs-sloppy` |
| 최상위 await(esm 출력) | `top-level-await` |
| TypeScript 모듈 | `typescript-modules` |
| 명확한 오류로 거부: 모호한 `export *` import, 없는 export, import 바인딩에 대입, 속성 없는 JSON import, `import.meta`, 정적으로 import하지 않은 모듈의 `import()`, iife/cjs의 최상위 await | `export-star-ambiguous-import`, `missing-export`, `assign-to-import`, `json-needs-attribute`, `import-meta`, `dynamic-import-unbundled`, `top-level-await-iife` |

비교하는 모든 번들에 절대 경로가 들어 있지 않은지도 확인합니다. 따로 있는 테스트 5개는 다음을 다룹니다.

- iife 전역 이름과, 그 이름을 통한 라이브 바인딩
- esm/cjs에서 Node 내장 모듈을 external로 두기, 그리고 iife에 `globals` 항목이 없을 때의 오류
- external이 아닌 bare 지정자에 대한 오류
- sloppy CommonJS가 strict인 esm 출력에 들어갈 때의 경고
- `importMeta: 'keep'`

### 빌드 파이프라인

`test/build.test.mjs`가 API로 확인하는 내용입니다.

- 해시 이름은 실제로 쓴 바이트의 sha256 앞 8자리이고, `manifest.json`은 반환값과 같습니다.
- `integrity`는 정확히 그 파일의 sha384입니다.
- 루트 기준 URL은 루트 기준으로, 상대 URL은 상대로 남습니다. 에셋이 아닌 링크는 그대로입니다.
- CSS 출력은 `@import`가 인라인되고 압축되며, `url()`은 그대로입니다.
- 빌드한 모듈 번들이 실행됩니다. 일반 스크립트는 iife로 감싸지므로 최상위 `var`가 전역이 되지 않습니다.
- 번들에 들어간 소스는 복사되지 않고, `publicDir`는 복사됩니다.
- 두 번 빌드해도 manifest가 같고, 어떤 출력에도 절대 경로가 없습니다.
- `hash: false`는 원래 이름을 유지하고, `clean`은 오래된 파일을 지웁니다.
- `clean: false`는 기존 파일을 남깁니다. `minify: false`면 번들과 CSS를 압축하지 않지만, `@import` 인라인은
  그대로 합니다.
- 위험한 출력 폴더는 거부되고, 아무것도 지워지지 않습니다.
- `html` 목록: 목록에 있는 페이지는 고쳐 쓰고, 없는 페이지는 그대로 복사합니다.
- `entries`: `name`이 있는 iife 엔트리를 `external` + `globals`와 함께 빌드하면 실행되고, external을 전역에서
  읽습니다.
- `watch`는 변경 후 다시 빌드하고(빠른 연속 쓰기 두 번에 재빌드 한 번), 자신의 출력 때문에 다시 빌드하지
  않습니다.

CLI로 확인하는 내용입니다.

- 설정 파일을 쓰는 `build`, `bundle --format iife --minify`(번들 실행 확인), `minify`, `css`, 알 수 없는
  명령(종료 코드 1), `--help`
- `test/examples.test.mjs`: `examples/site`를 임시 폴더에 복사해 실제 CLI로 빌드합니다. manifest, 고쳐 쓴
  페이지와 integrity 값, CSS 출력, 복사된 파일을 확인하고, 번들을 실행해 출력을 비교합니다.

다음 CLI 플래그는 플래그 자체로는 테스트하지 않았고, 같은 기능의 API 또는 설정 옵션으로만 테스트했습니다.

- `--watch`, `--integrity`, `--public`, `--no-hash`, `--no-clean`, `--no-minify`, `--root`, `--out`
- `bundle --name`, `--external`
- `bundle` / `minify` / `css`의 `-o`

### CSS

`test/css.test.mjs`가 확인하는 내용입니다.

- 압축기는 오라클로 검사합니다. `}` 앞의 마지막 `;`를 빼면, 공백과 주석이 아닌 모든 문자가 같은 순서로 남아야
  합니다.
- `url(...)`, 문자열, `content:` 값, 커스텀 프로퍼티 값(`--x: …`), `/*! … */` 주석은 바이트 단위로 그대로입니다.
- `a/**/b`는 두 단어를 계속 구분합니다. 두 번 압축해도 결과가 같습니다.
- `@import` 인라인: 중첩 import와 `url()` 재계산(따옴표 있음 / 없음), 미디어 목록의 `@media` 감싸기, 인라인된
  파일 목록 반환을 확인합니다.
- 원격 import, `layer(...)` import, 순환 import(경고와 함께)는 그대로 남깁니다.

### HTML

`test/html.test.mjs`가 확인하는 내용입니다.

- `script src`, `link href`, `img src`를 찾고, 주석과 `<script>`/`<style>` 등의 원시 텍스트는 건너뜁니다.
- 콜백이 지정한 값만 바꾸고, 따옴표를 포함한 나머지는 그대로 둡니다.

### TypeScript

`test/ts.test.mjs`(Node에 타입 제거 기능이 없으면 건너뜀)가 확인하는 내용입니다.

- 지울 수 있는 문법은 공백으로 바뀌므로 오프셋이 유지됩니다.
- 코드를 생성하는 문법(`enum`, namespace, 매개변수 프로퍼티)은 명확한 메시지와 함께 거부됩니다.
- Node의 `ExperimentalWarning`이 출력되지 않습니다.

### 압축기

`lib/minify.cjs`는 vanilla-kit 0.2.1 압축기(`browser/minify.js`, upstream 커밋 `50cd50f`)를 수정 없이 가져온
것입니다. upstream 파일과 다른 부분은 앞쪽 4줄짜리 헤더 주석뿐입니다.

동작은 다음과 같습니다.

- 주석과 공백을 지우고, 지역 변수임이 증명되는 이름만 줄입니다.
- 최상위 이름, 프로퍼티, 레이블, export는 절대 바꾸지 않습니다.
- 직접 `eval`, `with`, 이스케이프된 식별자가 있으면 이름 줄이기를 끕니다.
- 읽을 수 없는 입력은 추측하지 않고 줄과 열을 담은 오류를 던집니다.

upstream은 토큰 / 문장 / 바인딩 오라클로 검증합니다. upstream 기록은 **1,134개 파일 / 23.8 MB, 실패 0, 거부 0
(LF와 CRLF)**입니다.

이 저장소의 `scripts/check-corpus.mjs`(`npm run corpus -- <dir>...`)는 같은 오라클을 원하는 폴더에 돌립니다.
먼저 V8로 각 파일을 분류한 다음, 두 가지를 요구합니다.

- 압축 결과는 컴파일되고, 다시 압축할 수 있고, 토큰 열이 같아야 합니다(공백 제거 모드). 모든 식별자가 같은
  선언을 가리켜야 합니다(이름 줄이기 모드).
- 파서는 그 파일을 받아들여야 합니다. 스코프 분석으로 모든 지역 바인딩의 이름을 바꿔도, 압축기의 독립적인
  분석으로 볼 때 모든 식별자가 같은 선언을 가리켜야 합니다.

기록은 두 가지입니다.

- 첫 커밋 때 1,177개 파일 코퍼스로 파서와 스코프 분석을 확인했습니다. 그 코퍼스는 이 저장소에 없습니다.
- 이번 릴리스에서 이 저장소의 `bin/`, `test/`, `lib/parse/`와 vanilla-kit에 다시 돌렸습니다. 결과는 43개 파일,
  오라클 실패 0, 거부 0, 파서 수용 43/43, 바인딩 3,997개 이름 변경입니다.

### 설명만 있고 테스트는 없는 항목

설명한 대로 동작하지만, 이 저장소에 아직 테스트가 없는 항목입니다.

- `<link rel="modulepreload">` 번들링
- 기본값이 아닌 경로를 준 `--config <file>`
- default export가 함수인 설정 파일
- `@import ... supports(...)`를 그대로 남기는 동작
- 압축기의 `--no-mangle`, `--keep-fnames`, `--no-license` 플래그

## 제한 사항

- **소스 맵 없음.** JSX도 지원하지 않습니다. 파서는 데코레이터와 HTML 형식 주석도 거부합니다.
- **`node_modules` 해석 없음.** bare 지정자는 `external`에 적어야 하고, `package.json`의 `exports`는 읽지
  않습니다. 상대 import는 `.js .mjs .cjs .ts .mts .cts .json`과 `index.*`를 시도하며, `./x.js`가 `./x.ts`를
  가리킬 수 있습니다.
- **코드 분할 없음.** `import()`는 정적으로도 import한 모듈에만 쓸 수 있고, 나머지 `import()`는 거부합니다. 계산된
  `import()`는 네이티브로 남고, 계산된 `require()`는 실행 시점에 맡깁니다(둘 다 경고).
- **트리 셰이킹 / 죽은 코드 제거 없음.** 그래프의 모든 모듈이 들어갑니다.
- 최상위 await는 `esm` 출력이 필요합니다. `import.meta`는 `esm` 출력에서 `importMeta: 'keep'`을 줄 때만 허용합니다.
  ES 모듈을 `require()`하는 것은 거부합니다.
- sloppy 모드 CommonJS는 `esm` 출력 안에서 strict 모드로 실행되고, 경고가 나옵니다.
- **TypeScript:** 지울 수 있는 문법만 지원하고, 타입 검사는 하지 않습니다.
- **CSS:** 스타일시트 안의 `url()` 참조는 해시 이름으로 바꾸지 않습니다. 그 참조가 계속 동작하도록 원본 파일을
  해시 파일 옆에 함께 복사합니다. CSS 압축기는 공백과 주석만 지우고, 규칙 병합이나 값 축약은 하지 않습니다.
- **HTML:** 전체 HTML 파서가 아니라 태그 스캐너입니다. `<script src>`, `<link href>`, `<img src>`만 고쳐 씁니다.
  `srcset`, `<source>`, 인라인 `style`, `<a href>`는 건드리지 않습니다.
- **추가 엔트리:** 해시 이름은 `manifest.json`에만 기록됩니다.
- Windows + Node 26.13에서만 테스트했습니다. Linux / macOS CI와 Node 22에서는 아직 돌려 보지 않았습니다.

## 로드맵

- 소스 맵(번들러와 압축기)
- JSX
- `package.json` `exports` / `imports`를 포함한 `node_modules` 해석
- 해시 파일 옆에 미리 압축한 `.br` / `.gz` 출력
- vanilla-deploy의 빌드 단계로 통합

## 라이선스

MIT © 2026 FEABE. [LICENSE](LICENSE) 참고.
