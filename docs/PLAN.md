# MEDI PdM — 설비 예지보전 시스템 설계 문서

> 석유화학 공장 · dataPARC 연동 · **룰베이스 우선, AI는 선택 확장**

## 0. 문제 정의

- 현장 계기/전기/센서 신호는 dataPARC를 거쳐 PC에서 볼 수 있지만, **정비부서는 이상 신호를 생산팀이 말해주기 전엔 모른다.**
- 단일 태그 임계값 알람은 늦거나(이미 고장) 부하 변동에 오작동한다.
- 필요한 것: **여러 신호를 복합적으로 + 통계적으로** 분석해 열화를 조기에 잡고, 근거·권고조치와 함께 정비부서에 알려주는 도구.

## 1. 아키텍처

```
[현장 계기/DCS/전기설비]
        │
   [dataPARC]  PARCserver / dataPARC.Store 히스토리안
        │
        ├──(①REST ②OPC UA ③PARCdata SQL ④CSV)──┐
        │                                        │
   [게이트웨이 backend/ FastAPI]  ← 공장 PC에서 실행, 통일된 REST 제공
        │
   [웹앱 index.html]  ← 브라우저만 있으면 동작 (GitHub Pages/로컬 파일/사내 웹서버)
        ├─ 데이터소스: 데모 시뮬레이터 │ 게이트웨이 │ CSV 업로드
        ├─ 분석엔진(JS, 의존성 0): SPC·PCA·고장모드 매칭·5대 패턴
        ├─ 자산 온톨로지(ISO 14224/ISA-95/ISA-5.1)
        ├─ 알람 엔진(ISA-18.2 합리화)
        ├─ 룰베이스 진단 리포트(기본)
        └─ LLM 분석(선택 · API 키 입력 시 활성화)
```

설계 원칙
1. **오프라인 우선**: 웹앱은 빌드/CDN/서버 없이 `index.html` 더블클릭으로도 동작 (공장 내부망 PC 고려).
2. **룰베이스 완결**: API 키·인터넷 없이 모든 진단이 성립. AI는 "있으면 더 좋은" 계층.
3. **온톨로지 중심**: 자산·태그·고장모드 지식을 JSON 하나로 관리 → 룰베이스 근거이자 미래 LLM 컨텍스트.

## 2. dataPARC 연동 (조사 검증 결과)

dataPARC(Capstone Technology)가 공식 제공하는 외부 접근 수단과 권장 순위:

| 순위 | 방식 | 내용 | 비고 |
|---|---|---|---|
| ① | **dataPARC.Store REST API** | `GET /api/v1/read/raw·aggregate·at-time·current?tagIds=&start=&end=` | 신형 히스토리안. HTTPS 전용, OpenAPI 공개(github.com/dataPARC/store). 보안 활성 시 OAuth Bearer(`GET /auth-info`로 확인). 서버측 집계(TimeAverage 등 ~23종) 지원 → 대량 조회에 유리 |
| ② | **gRPC / .NET SDK** | `StreamRawData`, `ReadCurrentValues` 등 | 공식 Python 예제 존재. 대량 백필/스트리밍용. SDK NuGet은 벤더 피드 필요 |
| ③ | **OPC UA** | `opc.tcp://서버:51235/Capstone/OPCUAServer` | **모든 dataPARC 서버에 존재(구버전 포함)** — 가장 범용적 폴백. Anonymous/Username 인증, UA Security Console에서 허용 필요. 대량 히스토리 읽기는 성능 저하 가능 |
| ④ | **PARCdata SQL** | `SELECT * FROM ctc_fn_PARCdata_ReadRawTags('t1,t2',@s,@e,0)` | SQL Server CLR 함수. PARCdata 배포 사이트 한정(레거시) |
| ⑤ | **Excel/CSV 내보내기** | PARCview·Excel 애드인 | 수동. 검증/실습용 |

> ⚠ 히스토리는 SQL Server에 저장되지 않음(파일 기반 아카이브). `ctc_config` DB 직쿼리는 설정/이벤트만 나온다.

**현장 첫 단계 체크리스트**
1. `https://<서버>:12340/auth-info` 와 `/api/v1/read/current?tagIds=…` 응답 확인 (신형 여부)
2. UaExpert로 `opc.tcp://<서버>:51235/Capstone/OPCUAServer` 접속 확인 (폴백)
3. dataPARC 관리자에게: 읽기전용 역할(Security Console), TLS 인증서, (REST면) OAuth 정보 요청
4. `backend/config.yaml`에 커넥터+태그 매핑 작성 → 게이트웨이 기동 → 웹앱 연결 테스트

## 3. 분석 로직 (룰베이스 엔진)

### 3.1 단변량 SPC — `js/analytics/stats.js`
| 기법 | 용도 | 파라미터 |
|---|---|---|
| EWMA 관리도 | 소폭·지속 이동(서서한 열화) 조기 검출 | λ=0.2(빠름)/0.05(파울링류), L=3 |
| CUSUM(표형식) | 1σ급 평균이동 최속 검출 | k=0.5, h=5 |
| Western Electric/Nelson 런규칙 | 3σ 스파이크, 연속 상승 6점 등 패턴 | R1·R2·R3·R4·R5 |
| 강건 통계 | 이상치에 안전한 베이스라인 | MAD×1.4826 |
| 지속성/데드밴드 | 채터링 억제 | m-of-n, 히스테리시스 |

### 3.2 다변량 — `js/analytics/multivariate.js` (복합 신호 분석의 핵심)
- **PCA + Hotelling T²**: 정상운전 학습 → 운전점이 정상영역을 벗어나는지.
- **SPE/Q**: 신호 간 **상관구조 붕괴** 검출 — *개별 태그가 전부 정상범위여도* 관계가 깨지면 경보. 관리한계는 Jackson–Mudholkar + 경험적 분위수 중 보수적인 값.
- **기여도 분해**: 알람 시 어느 태그가 원인인지 상위 기여 태그 지목.
- **Mahalanobis 거리**: 설비 전체 신호를 한 점수로 — 건강지수의 근간.

### 3.3 설비별 물리 파생지표 — `js/analytics/equipment.js`

핵심 원칙: **부하로 설명되는 변화를 먼저 제거**(정상구간 회귀 잔차 `residualVs`)한 뒤 남는 이상만 본다.
부하 변동에 따른 공통 상승/하강으로 인한 오경보를 구조적으로 차단.

| 설비(클래스) | 지표 | 잡는 고장 | 물리 근거 |
|---|---|---|---|
| 원심펌프(CP) | 효율 프록시 Q·ΔP/I | 임펠러 마모, 캐비테이션 | 펌프 수력학 |
| 원심압축기(CO) | 서지마진, 압축비 보정 토출온도 | 서지 접근, 내부 오염 | 압축기 성능곡선 |
| 왕복동압축기(RC) | 단열 토출온도 잔차 T_d − T_s·r^((k−1)/k) | 밸브 누설(EFRC 조사 비계획정지 1위) | 단열 압축 |
| 열교환기(HE) | U값 프록시 Q/LMTD, 접근온도차 | 파울링, 튜브 누설 | 총괄전열 |
| 냉각탑(CT) | 접근온도차(냉수−습구근사), 효율 R/(R+A) | 충전재 오염, 팬 계통 | 증발냉각 |
| 변압기(TR) | 유온상승 vs 부하² 잔차, 유온 보정 유위 | 냉각 열화, 누유, 과부하 절연 열화 | IEEE C57.91 |
| 인버터 VFD(VF) | 방열판온도 vs I² 잔차, 전류 vs f² 잔차 | 냉각(팬/필터) 열화, 기계측 과부하 | 반도체 손실 ∝ I², 원심부하 토크 ∝ f² |
| 전동기(EM) | 권선온도 vs I² 잔차 | 냉각/절연 열화 | 동손 ∝ I² |
| 제어밸브(CV) | OP-개도 편차(pos_gap)와 그 진동성, PV 루프 진동성 | 스틱션(진동형), 액추에이터(단방향), 포지셔너 | 데드밴드-슬립 모델 |
| 증류탑(DC) | 유량 정규화 ΔP, 프로파일 ΔT | 플러딩 접근, 트레이 오염 | 탑 수력학 |
| 분해로(FH) | TMT−COT 갭, 배기 O₂/스택온도 | 튜브 코킹, 대류부 오염 | 관벽 열저항 |

시그니처 설계 포인트: 스틱션은 pos_gap의 **진동**(변동성·스파이크), 액추에이터 고장은 pos_gap의 **일방향 증가** —
같은 태그라도 패턴으로 감별. 고장모드에 `absent`(있으면 안 되는 증상) 필드로 오분류 차감.

### 3.4 고장모드 매칭 — `js/ontology.js`
ISO 14224 고장모드 라이브러리(증상 시그니처: `역할태그 × 패턴(상승/하강/변동성/스파이크) × 가중치`)에
관측 증상을 대조해 **일치도 점수 + 감별 포인트(미관측 증상) + 권고 조치**를 산출.

### 3.5 건강지수·알람 — `js/analytics/health.js`
- 건강지수 0–100: 다변량 위반율 + 고장모드 일치도 + 설계한계 접근의 가중 감점.
- 알람(ISA-18.2): m-of-n 지속성, 오프딜레이, **first-out 그룹핑**(고장모드 알람 활성 시 하위 추세/다변량 알람 억제 → 원인 1건=알람 1건), 우선순위 4단계, 근거/권고 첨부.

### 3.6 5대 분석 패턴 실습 — `js/analytics/patterns.js`
회귀(관계 잔차 감시) · 분류(룰 트리 상태 라벨링) · 군집(k-means 운전모드) ·
이상탐지(Mahalanobis/iForest/ECOD 전환 비교) · 시계열(Holt 예측 + 한계도달 시점 = 잔여수명 근사).
→ "분석 실습" 메뉴에서 내 업무 데이터(CSV)로 바로 실행 가능.

### 3.7 논문 검증 최신 기법 — `js/analytics/advanced.js`

조사 기준: 동료심사 논문 + 대규모 벤치마크에서 검증된 기법만 채택.
(2022 PVLDB 시계열 이상탐지 벤치마크에서 단순·고전 기법이 심층학습을 앞선 결과를 반영 —
LOF·BOCPD·Spectral Residual 등은 오탐/파라미터 민감성으로 제외)

| 기법 | 논문 | 구현 | 오탐 방지 장치 |
|---|---|---|---|
| Matrix Profile (STOMP) | Yeh et al. & Zhu et al., ICDM 2016 | QT 점화식 O(n²) 정확계산, 디스코드 top-K | 이상점수 최상위 태그에만 적용(m≈2h) |
| Isolation Forest | Liu et al., ICDM 2008 (인용 5,500+) | ψ=256, 트리 100, 시드 고정 | **정상 베이스라인 구간으로만 학습**(trainRange) |
| ECOD | Li et al., IEEE TKDE 2022 | 왜도 방향 ECDF 꼬리확률 합 | 파라미터 0개 — 튜닝 오류 원천 차단 |
| PELT 변화점 | Killick et al., JASA 2012 | 평균+분산 정규비용 len·log(v̂), BIC 페널티 | 스무딩+데시메이션 후 적용, 사후 평균>사전+2σ 검증 |
| 지수 열화 RUL | Gebraeel et al., IIE Trans. 2005 | φ 그리드 + 로그선형화 적합 | PELT 온셋 이후 구간만, R² 낮으면 미표시 |

**합의(consensus) 원칙**: iForest·ECOD가 모두 최근 구간 이상 판정 + 다른 근거(SPE 위반 또는 고장모드 일치)가
있을 때만 건강지수 감점. UI의 "열화 시작(PELT)" 표시도 동일 조건으로 게이팅 — 단일 알고리즘 오탐이
건강지수·화면에 새어들지 않게 함.

### 3.8 계기(트랜스미터) 건전성 — `instrumentHealth` (`js/analytics/equipment.js`)

공정 이상과 계기 자체 고장을 분리 진단. 벤더 자가진단(모두 공식 문서 검증)과 동일한 신호 시그니처를
히스토리안 측에서 근사 검사하고 NAMUR NE 107(F/C/S/M)로 분류.

| 검출 | 판정 로직 | 오탐 방지 | 벤더 근거 |
|---|---|---|---|
| 임펄스라인 막힘 | 1차 차분 σ(고주파 노이즈) 비율 < 0.3 + 평균 유지, 압력·차압·유량·레벨 한정 | 전체 σ가 아닌 고주파 성분만 봄(부하 변동 무시) | Rosemount 3051S SPM(DA2): "막힘 시 노이즈 σ 급감" 기술노트 · EJX ILBD(/DG6) · ABB 266 PILD |
| 출력 고착 | 최근 끝 연속 동일값 ≥1.5h | 개도(position)는 ≥12h(스틱션 플래토와 감별) | NE 107 F |
| 드리프트 | 단독 \|z\|>2.5 + R²>0.4 + 연관 태그 <0.8σ + 상위 고장모드로 설명 불가 | 고장모드 라이브러리가 설명하는 role 제외(TR 누유의 유위 하강 등) | 3144P Drift Alert · TTH300 드리프트 감시의 이중센서 논리를 태그 간 상관으로 근사 |
| 결선/EMI 노이즈 | 스파이크>0.6 + 동일 설비 타 태그 조용 + \|z\|<2 | 평균 이동 태그 제외(스파이크 지표 오염 방지) | NE 107 M |

- 알람: 별도 채널(`.instr.` 키), 막힘·고착은 중간 우선순위. first-out 억제 대상에서 제외.
- SPE 최대 기여 태그에 계기 이상이 있으면 SPE 알람에 "계기 원인 먼저 확인" 주석.
- 온톨로지: `INSTRUMENT_LIB`(계기 고장모드 4종 — 메커니즘·확인 순서·벤더 레퍼런스) + `VENDOR_REFS`(Emerson/Yokogawa/ABB 기종·진단기능, 검증 표기).
- 데모 시나리오: `pt202_plug`(노이즈 붕괴 후처리), `tt113_stuck`(flatline 후처리).

### 3.9 전기/디지털(접점) 신호 — `digitalDiagnostics` (`js/analytics/equipment.js`)

보호계전기 트립·Aux Relay·알람유닛 접점(0/1)은 아날로그 SPC와 문법이 다르므로 분리 처리
(태그 `kind:'digital'` — PCA/SPC 파이프라인에서 자동 제외, ISA-5.1 X 문자(XA/XS) 자동분류).

| 항목 | 로직 | 처리 |
|---|---|---|
| 트립(86 록아웃) | 접점 1 = 래치(리셋 전) | 긴급 알람 + 건강지수 즉시 경고 등급 + **상태기반 억제**(정지 설비의 fm/mv/trend/limit/instr 알람 전부 억제 — 정지된 모터의 저전류는 이상이 아니라 정지의 서술) |
| 알람 접점(49 등) | 접점 1 + 최근 활성시간 비율 | 높음 알람 — 트립 선행 경고 |
| 채터링 | 최근 에지율 > max(3×베이스라인, 1/h). 베이스라인은 앞 40% 고정 | 중간 알람 — 접점 마모/결선 이완/코일전압 (Omron 릴레이 FAQ 근거) |

레퍼런스(공식 문서 검증): ANSI/IEEE C37.2 디바이스 번호, Bently Nevada 3500/3300 XL/System 1(API 670,
OK 리밋·갭 전압), Atlas Copco Elektronikon Mk5/Nano·SMARTLINK, Yokogawa CENTUM VP·ProSafe-RS SOE·
Exaopc/Exaquantum, GE Multilin 869, ISA 18.1(어나운시에이터 first-out). → `VENDOR_REFS` + 온톨로지 화면 표.

데모: `m401_trip`(과열→49→86 래치→정지·냉각, 권선온도 1차지연 모델), `m401_relay_chatter`.

### 3.10 진단 원리 쉬운 설명 (UI 내장)

모든 진단 패널에 `explainBox()` 접이식 설명(❓ → 💡)을 내장 — 비유 중심(CUSUM=저금통,
iForest=스무고개 고립, SPE=키-몸무게 관계 붕괴, 86 트립=자물쇠, 채터링=혼자 딸깍거리는 스위치).
건강지수 감점 구조·알람 합리화(first-out·상태기반 억제) 설계 의도까지 화면에서 직접 설명.
목적: 교육(5대 패턴 학습)과 실무 인수인계 시 "왜 이 판정인지"를 도구 없이 전달.

## 4. 자산 온톨로지

- 구조: ISA-95 계층(사이트→구역→유닛→설비) + ISO 14224 설비클래스/고장모드 + ISA-5.1 태그 자동분류(PT/TT/FT/PDT/VT/IT…).
- 목적: ① 룰베이스 진단의 지식 근거 ② 태그 자동 해석 ③ **LLM 컨텍스트 직렬화**(`toLLMContext`) — 문헌상 LLM은 설비 지식을 자체 보유하지 못하므로, 컴팩트한 "자산 카드" JSON을 통째로 주는 방식이 정확도가 가장 높음.
- 편집: 화면에서 JSON 내보내기/가져오기 → 실제 공장 자산으로 교체.

## 5. LLM 분석 (선택 — 키 입력 시, 다중 제공자)

- 키가 없으면 완전 비활성. **룰베이스 리포트가 기본 경로.**
- 브라우저에서 직접 호출(BYOK) — 게이트웨이/중계서버 불필요. 제공자 4종(`js/llm.js`):

| 제공자 | 엔드포인트 | 인증 | 비고 |
|---|---|---|---|
| Anthropic | `POST /v1/messages` | `x-api-key` + `anthropic-dangerous-direct-browser-access: true` | 기본. 권장 모델 `claude-opus-4-8` |
| OpenAI | `POST /v1/chat/completions` | `Authorization: Bearer` | GPT 계열 |
| Google Gemini | `:streamGenerateContent?alt=sse&key=` | URL 키 | Gemini 계열 |
| OpenAI 호환 | Base URL 지정 `/chat/completions` | Bearer(키 없이도 가능) | 사내 Ollama/vLLM/LiteLLM/Azure — **인터넷 차단망에서도 사내 LLM 사용 가능** |

- 모델명 자유 입력(제공자별 권장 모델 datalist 자동완성), SSE 스트리밍 공통 처리.
- 컨텍스트 = 온톨로지 자산카드 + 관측 증상 + 통계 스냅샷 → 감별진단/정비계획 질의.
- 키 보관: 기본 메모리(새로고침 시 삭제), localStorage 저장은 명시적 옵트인. 제공자별 키 독립 보관.

## 6. 배포·운용

| 시나리오 | 방법 |
|---|---|
| 데모/학습 | GitHub Pages URL 접속 (main 병합 시 자동 배포) 또는 `index.html` 더블클릭 |
| 현장 PoC | dataPARC CSV 내보내기 → 웹앱 CSV 업로드 |
| 현장 상시 | 공장 PC에 게이트웨이 상주(backend/) + 웹앱을 로컬/사내 웹서버로 |

## 7. 로드맵

- **Phase 1 (완료)** 룰베이스 엔진 + 데모 시뮬레이터 + 5패턴 실습 + 게이트웨이 골격
- **Phase 1.5 (완료)** 설비 12종 확장(전기설비 포함: 변압기·VFD·전동기 / 왕복동압축기·냉각탑·제어밸브·증류탑·분해로), 논문 검증 기법 5종(§3.7), 다중 제공자 LLM(§5), UX/오버플로우 전면 개선
- **Phase 2 (현장 적용)** 실제 태그 매핑, 커넥터 확정(REST→UA 폴백), 온톨로지를 실제 자산으로 교체, 임계·베이스라인 캘리브레이션, 정상운전 구간 지정 UI
- **Phase 3 (고도화)** 알람 이력 DB화, 운전모드별 다변량 모델 분리(군집 활용), 정비이력 연계(고장모드 사후 검증), 이메일/메신저 알림
