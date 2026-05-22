---
"@ait-co/console-cli": patch
---

`serviceStatus: OPENED`를 라이브(in-service) 값으로 인식한다. `app ls`가 출시된 앱을 bare `approved` 대신 `in-service`로 표시하고, `app status`/`app show`가 `OPENED (출시 중)` 라벨을 붙인다. 기존 `RUNNING`은 tolerated alias로 유지.
