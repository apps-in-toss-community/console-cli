---
"@ait-co/console-cli": patch
---

저장된 크리덴셜을 사용한 headless 로그인이 Toss 90일 비밀번호 변경 인터스티셜 때문에 타임아웃되는 문제 수정.

- 비밀번호 교체 인터스티셜 자동 감지 (`business.toss.im/change-password-for-security`) 및 "90일 뒤에 변경" 버튼 클릭으로 무해하게 무시 (서버 측 90일 지속)
- submit 단계 타임아웃 메시지가 전체 `--timeout`(300s)이 아닌 실제 submit 관찰 창(30s)을 표시하도록 수정
- submit 단계 타임아웃 시 hard exit 대신 interactive 폴백으로 전환 (step-up 타임아웃은 기존처럼 hard exit 유지)
