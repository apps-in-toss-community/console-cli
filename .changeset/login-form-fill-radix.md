---
'@ait-co/console-cli': patch
---

`aitcc login`의 headless form-fill 흐름을 토스 비즈니스 sign-in 페이지 최신 구조(Radix UI)에 맞춰 갱신했습니다. 새 폼은 `name` 속성이 없고 email input이 `type="text"`라 기존 selector가 빈손으로 떨어져 `form-fill-find-email`로 interactive fallback이 항상 발생했습니다.

새 picker는 (1) `aria-label` / `placeholder`의 "이메일" / "비밀번호" 텍스트, (2) password input의 `closest('form')` 안에서 password 앞에 위치한 첫 text/email input을 마지막 fallback으로 사용합니다. password 폼 anchor 덕분에 무관한 검색 박스가 자격증명을 받을 위험은 그대로 차단됩니다.

`aitcc login` 사용자 영향: TTY에서 credential을 입력하거나 keychain에 저장해 둔 경우 다시 headless 흐름이 정상 동작합니다. `--interactive` 사용자는 이전과 동일.

Update the headless form-fill flow in `aitcc login` to track the latest Toss Business sign-in page (Radix UI). The new form has no `name` attributes and the email input is `type="text"`, so the previous selectors always missed and we fell back to interactive with `form-fill-find-email`.

The new picker matches on `aria-label` / `placeholder` containing "이메일" / "비밀번호", and falls back to the first text/email input that appears before the password input inside the same `<form>` — anchoring on the password input keeps a stray search box from capturing credentials.

User impact for `aitcc login`: users with credentials in TTY prompt or saved in the OS keychain get the headless flow working again. `--interactive` users are unaffected.
