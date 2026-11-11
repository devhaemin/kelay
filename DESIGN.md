# Kelay Design System

<!-- design-md:section experience -->
## 1. 경험

<!-- design-md:claim scope kind=product-surface lang=ko -->
Kelay는 소규모 소프트웨어를 위한 클라우드다. 이 문서의 범위는 빌더 콘솔(웹)과, Kelay SDK가 빌더의 앱 안에 넣어 주는 고객 팀용 설정 화면이다. 마케팅 사이트는 범위 밖이다.
<!-- design-md:claim-end -->

<!-- design-md:claim primary-tasks kind=user-outcomes count=5 lang=ko -->
- 빌더가 바이브코딩으로 만든 앱을 QA 결과를 보고 고객 팀에 배포한다.
- 빌더가 컬렉션과 역할마다 읽기·쓰기·삭제 범위를 정하고, 그 정책이 실제로 무엇을 보여 주는지 확인한다.
- 빌더가 유료 고객의 피드백을 받아, 에이전트가 만든 변경을 고객 미리보기로 확인한 뒤 승인한다.
- 빌더가 앱을 MCP·A2A로 열고, 같은 팀이 쓰는 다른 앱의 연결 요청을 허용한다.
- 고객 팀 관리자가 자기 팀의 AI 키를 팀 전용 서버에 연결한다.
<!-- design-md:claim-end -->

### 입장

빌더가 니치한 고객 한 명에게 집중하도록, 화면은 결정 하나만 묻는다.

### 원칙

- **P1 · 한 화면, 한 결정.** 화면마다 빌더가 내릴 결정은 하나다(배포할까, 적용할까, 승인할까, 허용할까). 결정 속도와 데모에서 1초 안에 읽히는 화면을 얻고, 지표를 한눈에 늘어놓는 대시보드형 개요를 포기한다.
- **P2 · 상태는 말로, 색은 점 하나로.** 배포됨·실패·대기 같은 상태는 문장과 8px 점으로 전달하고 카드 전체를 칠하지 않는다. 색 예산과 색각 이상 사용자의 판독을 얻고, 컬러 보드식 한눈 파악을 포기한다.
- **P3 · 고객의 말이 시스템 정보보다 위.** 피드백 인용과 고객 팀 이름이 가장 무거운 콘텐츠다. 머신 ID·리전·커밋 해시는 작은 모노 글자로 내린다. 니치 고객 집중이라는 제품 입장을 얻고, 인프라 세부를 표면에서 바로 읽는 편의를 포기한다.

### 피하는 것

- 지표 타일을 줄 세운 개요 화면, 아이콘 위 헤드라인 3열 카드
- 그라데이션, 유리 효과, 장식용 격자 배경, eyebrow 라벨
- 상태를 색만으로 구분하는 표, 카드 한쪽의 굵은 색 띠
- 근거 없는 수치("10배 빠른")와 축하 토스트

<!-- design-md:section foundations -->
## 2. 기반

<!-- design-md:claim foundations kind=rules-or-constraints lang=ko -->
### 색

| 토큰 | 값 | 쓰임 | 결정 |
|---|---|---|---|
| `color.paper` | `#F6F5F1` | 페이지 바탕. 따뜻한 틴트가 든 종이색 | D-P2-2 |
| `color.panel` | `#FDFCFA` | 패널·입력 바탕 | D-P2-2 |
| `color.ink` | `#1C1B18` | 본문·제목 (paper 대비 16.1:1) | D-P3-1 |
| `color.ink-2` | `#4A4840` | 보조 텍스트 (paper 대비 8.9:1) | D-P3-1 |
| `color.ink-3` | `#68655C` | 메타·모노 식별자 (paper 대비 5.5:1) | D-P3-1 |
| `color.line` | `#E3E0D7` | 1px 구분선. 표·입력·패널 경계에만 | D-P2-2 |
| `color.line-strong` | `#BDB9AD` | 컨트롤 테두리 (paper 대비 1.9:1, 입력은 라벨로 식별) | D-P2-2 |
| `color.accent` | `#1D6B47` | 주 버튼·포커스 링·선택 상태·"배포됨" 점 (paper 대비 6.0:1, 흰 글자 대비 6.5:1) | D-P1-2 |
| `color.accent-soft` | `#E4EFE8` | 선택된 행·셀 바탕 | D-P1-2 |
| `color.danger` | `#B3261E` | 오류 문장, 파괴적 행동, "실패" 점 (paper 대비 6.0:1) | D-P2-3 |
| `color.danger-soft` | `#F8E7E4` | 오류 배너 바탕. 이것 말고는 배경 틴트를 쓰지 않는다 | D-P2-3 |
| `color.warn` | `#8A5A00` | "대기" 점과 문장 (paper 대비 5.4:1) | D-P2-1 |

- accent는 뷰포트 면적의 5% 이하로 쓴다. 화면당 주 버튼은 1개다 (D-P1-1, D-P1-2).
- 상태 점은 항상 상태 문장과 함께 쓴다. 점만 단독으로 쓰지 않는다 (D-P2-1).

### 간격

4px 반 단계를 둔 8px 체계: `4 · 8 · 12 · 16 · 24 · 32 · 48 · 64`. 그룹 안 간격은 그룹 사이 간격보다 작다. 목록 행 높이 52px, 표 셀 최소 44px (D-P1-5).

### 모양

| 토큰 | 값 | 쓰임 | 결정 |
|---|---|---|---|
| `radius.control` | `6px` | 버튼·입력·셀 | D-P2-4 |
| `radius.panel` | `10px` | 패널·팝오버. 안쪽 컨트롤과 4px 패딩이면 6 + 4 | D-P2-4 |
| `radius.pill` | `999px` | 상태 점·숫자 배지 | D-P2-4 |

### 깊이

패널은 1px `color.line`과 `color.panel` 톤 차이로만 구분한다. 그림자는 떠 있는 층(팝오버·메뉴)에만 쓴다: `0 1px 2px rgb(28 27 24 / 6%), 0 4px 12px rgb(28 27 24 / 8%), 0 12px 32px rgb(28 27 24 / 10%)` (D-P2-2).

### 모션

- 호버 150ms, 팝오버 열기 200ms·닫기 150ms, `cubic-bezier(0, 0, 0.2, 1)`. transform과 opacity만 움직인다 (D-P2-5).
- 포커스 링은 즉시 나타난다. 2px `color.accent`, 2px 오프셋.
- `prefers-reduced-motion: reduce`이면 모든 전환을 즉시로 바꾼다.
<!-- design-md:claim-end -->

<!-- design-md:section typography-assets -->
## 3. 타이포그래피와 에셋

### 서체

- 본문·제목: **Pretendard Variable** (SIL OFL 1.1, jsDelivr `orioncactus/pretendard@v1.3.9` 동적 서브셋). 굵기 400·500·600·700만 쓴다.
- 모노: 브랜드 모노 서체는 정하지 않았다. 시스템 스택 `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`를 쓰고, 이것을 브랜드 서체로 소개하지 않는다.

### 역할

| 역할 | 크기 / 행간 | 굵기 | 자간 | 결정 |
|---|---|---|---|---|
| 페이지 제목 h1 | 28px / 1.3 | 700 | −0.02em | D-P1-3 |
| 섹션 제목 h2 | 20px / 1.4 | 600 | −0.01em | D-P1-3 |
| 고객 인용 | 18px / 1.55 | 500 | 0 | D-P3-1 |
| 본문 | 16px / 1.5 | 400 | 0 | — |
| 보조·표 | 15px / 1.45 | 400·500 | 0 | D-P1-5 |
| 메타·모노 식별자 | 13px / 1.45 | 400·500 | 0 | D-P3-1 |

- 한글 제목·버튼·라벨은 `word-break: keep-all`과 `overflow-wrap: anywhere`를 함께 쓴다. 본문은 `normal`.
- 바뀌는 숫자에는 `tabular-nums`를 쓴다. 기울임은 쓰지 않는다.

### 에셋

- 로고: 미정. 워드마크 자리에 Pretendard 700 텍스트 "Kelay"를 쓴다.
- 아이콘: 아이콘 세트를 정하지 않았다. 텍스트 라벨과 CSS로 그린 점·화살표만 쓴다.
- 스크린샷: 피드백에 첨부된 고객 화면이 유일한 이미지 콘텐츠다.

<!-- design-md:section components-states -->
## 4. 컴포넌트와 상태

모든 인터랙티브 컴포넌트는 기본·호버(포인터가 있을 때)·포커스(`:focus-visible`)·누름·비활성을 갖는다. 비활성은 투명도만으로 표현하지 않고, 바탕·글자 색을 함께 바꾸며 이유를 옆에 적는다.

- **주 버튼** — `color.accent` 바탕, 흰 글자, 높이 40px(터치 기기 44px). 화면당 1개. 로딩 중에는 라벨을 진행형으로 바꾸고("배포하는 중") 너비를 유지한다.
- **보조 버튼** — `color.panel` 바탕, `color.line-strong` 1px 테두리. 상태가 바뀌어도 테두리 두께는 그대로다.
- **조용한 버튼** — 글자만. 복사·더 보기 같은 부차 행동.
- **상태 표시** — 8px 점 + 상태 문장. 배포됨=accent, 실패=danger, 대기=warn, 꺼짐=ink-3. 인터랙티브가 아니다.
- **목록 행** — 첫 열은 고객 팀 이름(D-P3-2). 행 전체가 링크면 안쪽에 경쟁하는 버튼을 두지 않는다. 선택된 행은 `color.accent-soft` 바탕과 `aria-current`.
- **권한 셀** — 셀을 누르면 범위 목록(전체 · 담당한 것만 · 없음)이 팝오버 리스트박스로 열린다. 네이티브 select를 쓰지 않는다. 방향키로 이동, Enter로 선택, Esc로 닫고 셀로 포커스를 되돌린다. 에이전트가 제안한 변경은 셀에 "제안" 표시와 accent 테두리.
- **텍스트 입력** — 높이는 버튼과 같다. 라벨은 항상 위에 보이고, 오류는 아래 고정 슬롯에 danger 문장으로. 포커스는 테두리 두께가 아니라 포커스 링으로 표시한다.
- **선택 카드(라디오)** — 커스텀 스타일 라디오. 선택되면 accent 테두리와 점.
- **진행 단계** — 피드백이 반영되는 단계(받음 → 에이전트 구현 → QA → 고객 미리보기 → 승인 → 배포). 끝난 단계는 ink, 현재 단계는 accent 점과 굵게, 남은 단계는 ink-3.
- **코드 블록** — `color.paper` 바탕, 모노 13px, 가로 스크롤은 블록 안에서만(`overscroll-behavior: contain`).

<!-- design-md:section layout-platforms -->
## 5. 레이아웃과 플랫폼

- **앱 셸** — 왼쪽 사이드바 240px + 본문 최대 1120px, 넓은 화면에서는 본문을 왼쪽 정렬하고 남는 폭은 비운다.
- **페이지 헤더** — 제목·한 줄 설명은 왼쪽, 주 버튼은 오른쪽 (D-P1-1). 결정에 필요한 근거는 헤더 바로 아래 첫 패널에 둔다 (D-P1-4).
- **문법** — 개요·연결: 단일 열 목록. 권한: 표 + 오른쪽 확인 패널. 피드백: 마스터-디테일(목록 360px + 상세).
- **반응형** — 최소 지원 폭 320px. 900px 미만에서 사이드바는 상단 바 + 메뉴 버튼이 되고, 마스터-디테일과 오른쪽 패널은 아래로 쌓인다. 주 버튼은 헤더 아래로 내려와 전체 폭이 된다. 표는 자기 컨테이너 안에서만 가로로 스크롤한다. 페이지 전체 가로 스크롤은 없다.
- 터치 기기(`pointer: coarse`)에서 탭 대상은 44px 이상, 인접 대상 사이 8px 이상.

<!-- design-md:section content-locales -->
## 6. 콘텐츠와 로케일

- 지원 로케일: `ko` 하나. `<html lang="ko">`.
- 말투: 해요체 하나. 빌더를 주어로, 시스템 상태가 아니라 결과를 말한다: "배포했어요", "정책 테스트 27개를 통과했어요" (D-P3-3).
- 버튼은 결과를 동사로: "3개 팀에 배포하기", "승인하고 배포하기", "키 저장하기". 창만 닫는 버튼은 "닫기".
- 오류는 무슨 일이 생겼는지와 지금 할 일을 함께 쓴다. 오류 문장에는 느낌표와 코드를 쓰지 않는다.
- 용어는 하나로 고정한다: 배포(ship), 고객 팀(tenant), 권한 정책(RLS policy), 피드백, 미리보기, 연결, 팀 키. MCP·A2A·RLS는 영문 그대로 쓰되 화면에서 처음 나올 때 한국어로 풀어 준다. 컬렉션 이름(`leads`)과 역할 이름은 빌더가 정의한 어휘이므로 화면에 그대로 보여 준다.
- 날짜·시간: "11월 11일 14:20", 범위는 "10:00~18:00". 숫자는 `ko-KR` 묶음(1,234), 단위는 붙인다(49,000원, 36개).

<!-- design-md:section governance -->
## 7. 거버넌스

<!-- design-md:claim authority kind=portable-brief lang=ko -->
이 문서는 명시된 범위의 이식 가능한 디자인 브리프다.
<!-- design-md:claim-end -->

<!-- design-md:claim application-priority order=prompt-fact,repository-fact,system-contract,reference-inspiration lang=ko -->
1. 요청 범위의 명시적 사용자 지침.
2. 저장소 사실.
3. 이 시스템 계약.
4. 레퍼런스 영감.
<!-- design-md:claim-end -->

<!-- design-md:claim unknowns policy=absent-at-smallest-unresolved-boundary lang=ko -->
가장 작은 미확정 값이나 그룹만 생략한다. 그럴듯한 기본값으로 대체하지 않는다.
<!-- design-md:claim-end -->

<!-- design-md:claim changes policy=review-record-validate-before-adoption lang=ko -->
채택 전에 변경을 기록하고 검토하고 검증한다.
<!-- design-md:claim-end -->

- 모든 결정은 에이전트가 제안한 그린필드 결정이다. 제품 오너가 검토하기 전까지는 브리프로 다룬다.
- 새 값이 필요하면 결정 표에 `D-<원칙>-<번호>`를 먼저 추가한 뒤 토큰과 화면에 쓴다.

<!-- design-md:claim omitted count=4 lang=ko -->
### 생략

- `foundations.color.dark` — `unresolved`: 다크 모드 색은 정하지 않았다.
- `typography-assets.logo` — `unresolved`: 로고와 심볼이 없다. 텍스트 워드마크만 쓴다.
- `typography-assets.font.mono` — `unresolved`: 브랜드 모노 서체를 정하지 않았다.
- `typography-assets.icons` — `unresolved`: 아이콘 세트를 정하지 않았다.
<!-- design-md:claim-end -->
