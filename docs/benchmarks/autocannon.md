Node v24.13.1, 11th Gen Intel(R) Core(TM) i5-1145G7 @ 2.60GHz (8 threads), 16 GB RAM, 50 connections × 15s per scenario, 2 server workers

| Scenario | Requests | Req/s | p50 ms | p95 ms | p99 ms | max ms | Budget | Result |
|---|---:|---:|---:|---:|---:|---:|---:|:---:|
| GET /translations (first page, 50) | 11424 | 762 | 60 | 111 | 166 | 837 | 200 ms | PASS |
| GET /translations?key=checkout.button. | 7990 | 533 | 88 | 142 | 161 | 437 | 200 ms | PASS |
| GET /translations?q=payment (word) | 6931 | 462 | 118 | 176 | 274 | 894 | 200 ms | PASS |
| GET /translations?q=ccoun (substring) | 7394 | 493 | 97 | 138 | 160 | 704 | 200 ms | PASS |
| GET /translations?q=zqxjkv (no match) | 15733 | 1049 | 18 | 104 | 139 | 1015 | 200 ms | PASS |
| GET /translations?q=%234999 (rare) | 9051 | 603 | 89 | 126 | 154 | 496 | 200 ms | PASS |
| GET /translations?tags=mobile | 9094 | 606 | 105 | 162 | 216 | 718 | 200 ms | PASS |
| GET /translations?tags=web,mobile&tagsMode=all | 5461 | 364 | 158 | 270 | 380 | 1259 | 200 ms | FAIL |
| GET /translations?locale=fr&q=paiement | 9224 | 615 | 78 | 121 | 157 | 849 | 200 ms | PASS |
| GET /locales | 29555 | 1970 | 24 | 35 | 43 | 73 | 200 ms | PASS |
| GET /tags | 36738 | 2450 | 19 | 27 | 37 | 66 | 200 ms | PASS |
| GET /translations?cursor=… (deep page) | 11647 | 776 | 63 | 98 | 122 | 709 | 200 ms | PASS |
| GET /translations/:id | 27487 | 1832 | 35 | 50 | 70 | 283 | 200 ms | PASS |
| POST /translations | 6770 | 451 | 101 | 169 | 218 | 342 | 200 ms | PASS |
| PATCH /translations/:id | 11145 | 743 | 20 | 152 | 194 | 920 | 200 ms | PASS |
| GET /export/en cold (n=15, sequential) | 15 | – | 197 | 320 | 320 | 320 | 500 ms | PASS |
| GET /export/en warm (pre-gzipped) † | 3278 | 234 | 209 | 439 | 512 | 613 | 500 ms | PASS |
| GET /export/en?format=nested warm † | 4641 | 313 | 158 | 209 | 224 | 300 | 500 ms | PASS |
| GET /export/en 304 (If-None-Match) | 45979 | 3066 | 14 | 29 | 45 | 343 | 50 ms | PASS |

† 4 autocannon worker threads (a single client thread saturates on ~0.6 MB bodies before the server does); "p95" column shows p97.5, an upper bound.
