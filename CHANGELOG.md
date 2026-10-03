# 📜 Lịch sử phiên bản

Mọi thay đổi đáng chú ý của SanoVids. Bản cài `.exe` của từng phiên bản có ở trang tải về [sanovids-releases](https://github.com/JameSteven404/sanovids-releases/releases).

Ký hiệu: ✨ thêm mới · 🛠️ thay đổi · 🐞 sửa lỗi · ⚠️ lưu ý

---

## [0.5.0] — 2026-10-03 — Tự động cập nhật

✨ **SanoVids tự cập nhật** (bản cài Setup)
- Không phải tải và cài lại bằng tay mỗi lần có bản mới nữa. SanoVids tự tìm bản mới khi mở app và 4 giờ một lần, rồi **tải về trong nền**: bạn cứ làm việc bình thường. Thường chỉ tải phần thay đổi nên nhẹ hơn cả bộ cài.
- Tải xong, thanh trên cùng hiện nút **Cập nhật 0.5.x**. Bấm vào → **Khởi động lại để cập nhật**: SanoVids lưu dự án, cài bản mới rồi tự mở lại. Chọn **Để sau** thì bản mới **tự cài khi bạn tắt SanoVids**.
- Đang có video tạo dở? Chọn **Cập nhật khi xong**: SanoVids đợi hết video đang tạo, đang chờ và lượt nạp credit, rồi báo trước 5 giây (bấm **Huỷ** được) mới khởi động lại. Bấm **Cập nhật ngay** cũng an toàn: video đang tạo vẫn chạy tiếp trên máy chủ, SanoVids theo dõi lại sau khi mở lên, không bị trừ credit hai lần.
- Trước khi khởi động lại, SanoVids đợi video đang được gửi đi gửi xong, giữ lại chữ đang gõ dở trong ô prompt và lưu dự án.
- Mở lại sau khi cập nhật sẽ thấy thông báo **"Đã cập nhật SanoVids lên …"**. Dự án, video và cài đặt giữ nguyên.
- Hộp **Cập nhật SanoVids** cho xem trước **Có gì mới**, dung lượng và tiến độ tải.
- **Cài đặt → Cập nhật**: xem phiên bản đang dùng, lần kiểm tra gần nhất, nút **Kiểm tra ngay** và công tắc **Tự động tải bản cập nhật** (bật sẵn; tắt thì app chỉ báo có bản mới, bạn bấm để tải). Công tắc này khác với "Tự tải khi video xong" (tải video về máy).

⚠️ **Lần này phải cài tay 0.5.0 một lần**
- Bản 0.4.2 trở về trước chưa biết tự cập nhật: tải `SanoVids-Setup-0.5.0.exe` và **cài tay 0.5.0 một lần**, cài đè lên bản cũ (đóng SanoVids trước; dự án và cài đặt giữ nguyên). Từ 0.5.0 trở đi các bản sau tự về.
- **Portable chỉ báo có bản mới**: bản Portable không tự cài được. Khi có bản mới, app hiện **Bản mới …** trên thanh trên cùng và nút **Tải bản mới** mở trang tải về. Muốn tự cập nhật, hãy dùng bản Setup.
- File `.exe` vẫn chưa có chữ ký số. Bản cập nhật chỉ tải qua HTTPS từ GitHub và được kiểm tra bằng mã SHA-512 ghi trong `latest.yml`; file sai mã bị bỏ, không bao giờ được cài.
- Bản mới nào đổi phiên bản Electron (lõi của app) thì phải tải gần như cả bộ cài (khoảng 100 MB).

🛠️ **Trang tải về chuyển sang** [github.com/JameSteven404/sanovids-releases](https://github.com/JameSteven404/sanovids-releases/releases/latest): trang công khai, chỉ chứa file cài đặt và file dùng cho việc tự cập nhật. Mỗi lần kiểm tra, app chỉ gửi cho GitHub một mã cài đặt ngẫu nhiên, không gửi gì từ dự án của bạn.

## [0.4.2] — 2026-10-02 — Dây nối chạm đúng tâm chấm tròn

🐞 **Dây nối không còn toả rộng cạnh chấm**
- Mọi loại dây (ảnh, `@video`, khung đầu/cuối, cảnh → video, lưu và tự lưu vào Thư mục) giờ **bắt đầu và kết thúc đúng tâm chấm tròn**. Đúng trên mọi loại node, kể cả thẻ đã đổi kích thước hay thu nhỏ khi zoom xa, ở mọi mức zoom (đo lệch 0 px).
- Cảnh nhận nhiều dây (ví dụ 10 dây `@video` vào một cảnh) không còn bị xoè thành "răng lược" cạnh chấm: các dây **chụm mượt vào một chấm**, chấm nằm đè lên đầu dây. Chọn một dây không làm cả bó nhảy chỗ.
- Dây lúc đang kéo, chỗ hút khi rê tới, dây sau khi thả và nút nắm đầu dây đều ở cùng một điểm: thả tay ra dây không còn giật.
- Chấm phóng to khi rê chuột / đang nối không còn làm đầu dây lệch vài px sau đó.

🛠️ **Chấm nối đồng bộ, dễ bấm hơn**
- Mọi chấm cùng một kiểu: cùng cỡ, viền màu nền, cùng hiệu ứng khi rê chuột / đang nối.
- Chấm tham chiếu của cảnh **đổi màu theo dây đang nối vào**: xanh ngọc cho ảnh, tím cho video, hai màu khi có cả hai.
- Dây đang chọn hoặc đang rê chuột được vẽ nổi lên trên các dây khác trong bó.
- Bấm vào chấm không còn cắt nhầm dây, cũng không còn đổi kích thước thẻ nhầm khi thẻ đang được rê chuột / chọn. Bấm vào thân dây để cắt vẫn như cũ.
- Chấm của node video luôn nằm giữa ảnh, kể cả khi đổi kích thước: không còn nhảy 8 px. Dây cảnh → video vẫn thẳng hàng.
- Nhãn **ĐẦU / CUỐI** (MiniMax-H3 khung đầu/cuối) nằm ngay bên trái chấm, ngoài thẻ, không còn đè lên dòng thông số.

## [0.4.1] — 2026-10-02

🛠️ **Node Thư mục gọn gàng hơn**
- Mọi dây nối vào node Thư mục giờ **chụm vào đúng chấm tròn** của node, không còn toả rộng ở mép thẻ.
- Nút chính là **Mở thư mục**; đổi sang thư mục khác bằng nút biểu tượng nhỏ bên cạnh. Chữ trên nút không còn bị cắt ("Chọn thư m…").
- Hàng nút tách khỏi phần thông tin bằng một đường mảnh, chấm nối có viền sáng nhẹ.

## [0.4.0] — 2026-10-02 — Lưu video, node Thư mục, cắt dây, Storyboard kéo-thả, Cài đặt mới

✨ **Hỏi nơi lưu & đổi tên khi tải video** (bật sẵn)
- Bấm **Tải video…** mở hộp **Save As** của Windows, có sẵn tên file để sửa, nhớ thư mục lần trước. File `.txt` prompt được lưu **cạnh video, cùng tên bạn chọn**. Tải `.zip` cũng hỏi.
- Tự tải và node Thư mục không hỏi. Tắt trong **Cài đặt → Tải video** để quay lại kiểu cũ.

✨ **Đổi tên video đầu ra**
- Bấm đúp vào tên trên node video (hoặc nút bút chì), hoặc sửa ô **Tên file** trong cửa sổ xem take. Tên này dùng cho mọi cách lưu: tải, .zip, tự tải, node Thư mục. Để trống là quay về tên mặc định.
- **Mẫu đặt tên** trong Cài đặt → Nâng cao: `{scene}` `{take}` `{title}` `{project}` `{date}` `{time}` `{model}`, xem trước tên ngay khi gõ. Mặc định vẫn là `S01_T1 - tên cảnh`.

✨ **Node Thư mục trên canvas**
- Nút **Thư mục** trên thanh công cụ: chọn một thư mục trên máy. Node hiện tên, đường dẫn, **số video đã lưu**, lần lưu gần nhất và nút **Mở thư mục**.
- **Nối video → Thư mục**: chép video vào ngay. Video đang tạo thì chép khi xong.
- **Nối cảnh → Thư mục** (dây nét đứt): mọi video mới của cảnh đó **tự lưu** vào thư mục khi tạo xong.
- Không bao giờ ghi đè: trùng tên thì thêm " (2)". App chỉ ghi vào những thư mục chính bạn đã chọn. Đường dẫn thư mục **không bị ghi** vào file xuất dự án.
- Dây màu chàm, cắt dây và hoàn tác như dây khác. Video chưa lưu được (thư mục bị đổi chỗ hoặc mất quyền) được giữ lại và lưu khi bạn bấm **Chọn lại thư mục**.

✨ **Bấm vào dây là cắt** (bật sẵn)
- Vùng bấm quanh dây rộng 16 px, con trỏ hình kéo, có **Hoàn tác** ngay trong thông báo. App phân biệt bấm với kéo, nên kéo canvas không cắt nhầm. Dây cảnh → video của chính nó không bao giờ bị cắt. Ctrl/Shift + bấm thì chỉ chọn dây.
- Tắt trong **Cài đặt → Dây nối & canvas** để quay lại kiểu cũ: bấm để chọn, rồi Delete.

✨ **Hoạt ảnh dây mượt hơn**
- **Cắt dây**: dây tách ra từ đúng điểm bấm, hai nửa co lại và mờ dần (cả khi xoá bằng phím Delete).
- **Kéo dây**: dây cong mềm theo con trỏ, mang màu loại nguồn (ảnh xanh, video tím, thư mục chàm), có vệt sáng chạy về phía con trỏ. Rê tới thẻ nhận được thì đầu dây hít vào điểm nối, rê tới chỗ không nhận thì hiện kiểu báo không hợp lệ.
- Hiệu ứng chuyển động: **Đầy đủ / Giảm / Tắt** (Cài đặt → Nâng cao). Tự giảm khi Windows bật chế độ giảm chuyển động.

✨ **Storyboard: kéo-thả để sắp xếp**
- Nắm thẻ video kéo sang vị trí mới. Các thẻ khác dịch chỗ mượt theo, có vạch báo chỗ thả. Thả xong thì thứ tự cảnh đổi, mã cảnh tự đánh lại, **một lần Hoàn tác**.
- Không cần kéo: chọn thẻ rồi **Alt + ←/→** hoặc **Alt + ↑/↓**. Phát liền và tải .zip đi theo thứ tự mới.

✨ **Cài đặt mới: Cơ bản / Nâng cao + tìm kiếm**
- **Cơ bản**: giao diện, tải video (hỏi nơi lưu, **kèm file .txt hay không**, tự tải, thư mục mặc định), âm thanh video (tiếng, âm lượng, tốc độ), dây nối & canvas, tự đánh lại số @image, dữ liệu dự án, **Chế độ Phát triển**.
- **Nâng cao**: hiệu ứng chuyển động, thời gian hiện thông báo (có nút Xem thử), mẫu tên file, .zip kèm prompt, cổng canvasapp, bố cục khung bên, **sao lưu / khôi phục cài đặt**, **khôi phục mặc định**.
- Ô tìm kiếm gõ không dấu cũng tìm ra. **Ctrl+F** để nhảy vào ô tìm kiếm.

🛠️ Từ bản này SanoVids **chỉ còn bản app desktop**: bản web đã tắt.

## [0.3.0] — 2026-10-02 — Chế độ Phát triển thay cho Demo

✨ **Chế độ Phát triển (mặc định)** — để tìm và sửa lỗi mà không tốn tiền
- Thay cho "Demo giả lập": SanoVids chạy **đúng mã của cổng canvasapp thật** (đăng nhập, số dư, tải ảnh lên, canvas cầu nối, tạo job, theo dõi, tải video, nạp credit qua SePay, lịch sử credit) nhưng tới một **canvasapp.io.vn giả lập ngay trong app** — không gọi mạng, credit dev không phải tiền thật. Chạy được cả trên web.
- Ô credit: **DEV 1.000 credit** (viền đứt), **DEV · Đăng nhập** mở trang đăng nhập giả lập, nút **+** mở nạp credit với **trang SePay giả lập** (Thanh toán thành công / Huỷ / Lỗi / Đóng cửa sổ).
- Video giả ghi nhãn **@image_1, @image_2…** lên từng ảnh theo đúng thứ tự canvasapp nhận, để kiểm tra đúng nhân vật bằng mắt.

✨ **Bảng phát triển** (nút 🐞 trên thanh trên cùng, Cài đặt → Chế độ Phát triển)
- **Trạng thái**: đăng nhập / đăng xuất / hết phiên, đặt số dư, tốc độ (≈ 8 giây hoặc thực tế 60–90 giây), bật/tắt nạp credit, chống trùng job, 402/400, độ trễ, tỉ lệ lỗi, bật/tắt model và chế độ, xoá dữ liệu giả lập.
- **Gây lỗi** một chạm (một lần hoặc “giữ”): mất mạng, mất câu trả lời sau khi đã tạo job, 502, 200 không có mã job, 402, 422, Invalid canvas payload, hết phiên 401, 429, job tiếp theo lỗi / hết hạn, tải video lỗi N lần, tải ảnh lên lỗi, chậm 3 giây… hoặc tự tạo lỗi.
- **Nhật ký** mọi yêu cầu (JSON, lọc, **Copy nhật ký** để báo lỗi) và **Kiểm tra nhân vật** cho từng lần tạo job.
- **Job & đơn nạp**: hoàn tất / cho lỗi / cho hết hạn job, quyết định kết quả đơn nạp, xem ảnh đã tải lên.

🐞 Sửa lỗi tìm được nhờ chế độ Phát triển
- Ô trạng thái “Đang chờ thanh toán” trong Nạp credit bị **co còn một dòng** (lỗi trùng tên class) — giờ hiện đầy đủ.
- Dự án mẫu dùng ảnh SVG nên **không chạy được qua cổng canvasapp** (chỉ nhận JPG/PNG/WEBP) — dự án mẫu tạo mới giờ dùng ảnh PNG.

🛠️ Chế độ Phát triển giống canvasapp thật hơn
- Mở SanoVids ở **nhiều tab** giờ dùng **chung một tài khoản giả lập** (trước đây tab này có thể ghi đè job, số dư, lịch sử của tab kia).
- Lỗi giả **cộng dồn**: “Chậm 3 giây” (giữ) không còn che mất lỗi bật sau nó; lỗi bật cho đúng một yêu cầu được ưu tiên hơn lỗi “mọi yêu cầu”. “Hết phiên (401)” được đếm là một lỗi đang bật cho tới khi đăng nhập lại.
- “Invalid canvas payload (400)” giờ áp cho cả lần SanoVids tự thử lại, nên đúng như mô tả: take báo lỗi, không gửi job, không trừ credit.
- Tiến độ job giả lập được đọc đúng **mỗi 3 giây** (trước đây thực tế 6 giây); số dư thấy ngay tiền nạp / tiền hoàn đã tới hạn.
- Thông báo lỗi của take ở chế độ Phát triển chỉ tới **Bảng phát triển** thay vì bảo kiểm tra trên canvasapp.io.vn; thông báo “chưa đăng nhập” chỉ đúng chỗ đăng nhập (ô credit hoặc Cài đặt → Nhà cung cấp video) ở cả hai chế độ.
- Nạp credit: đơn nạp đã xong của chế độ kia được bỏ khi đổi nhà cung cấp — chế độ Phát triển không còn gọi canvasapp thật vì một đơn cũ.
- Nhấn Esc sau khi bấm ra ngoài trang SePay giả lập chỉ đóng trang đó, không đóng hộp Nạp credit bên dưới. Dữ liệu giả lập hỏng một phần không làm treo Bảng phát triển (có nút xoá để bắt đầu lại); dữ liệu cũ được dọn bớt, có cảnh báo khi bộ nhớ trình duyệt đầy.

🛠️ “Dự án demo” đổi tên thành **Dự án mẫu**. Take tạo bằng demo cũ vẫn xem, tải, xoá được (ghi “Demo cũ”).

⚠️ Giống cổng thật, chế độ Phát triển **chưa nhận video tham chiếu `@video_N`** (demo cũ thì có): bỏ `@video_N` để chạy cảnh tiếp nối.

## [0.2.5] — 2026-10-02

🐞 **Node mới không còn "bay" ra xa**
- Bấm **+ Cảnh** / `N` / **Cảnh mới** khi không chọn cảnh nào: cảnh mới nằm **ngay dưới cảnh bạn vừa chọn hoặc vừa tạo** (chọn một nhân vật cũng không làm mất mốc này). Nếu cảnh đó không nằm trong vùng đang nhìn thì đặt dưới cảnh thấp nhất trong vùng nhìn, còn không có cảnh nào trong vùng nhìn thì đặt giữa màn hình. Trước đây cảnh mới luôn về cột bên trái (x 420) ở hàng tính theo số cảnh, có khi cách chỗ bạn làm hàng nghìn px.
- Cảnh mới **không đè** lên thẻ nhân vật, video đã kéo ra chỗ khác hay hàng video của cảnh khác: nó vào chỗ trống gần nhất ngay cạnh (dưới, trên hoặc bên cạnh), không trượt xuống hết một cột dài.
- **Bấm đúp** lên nền canvas: cảnh mới nằm đúng chỗ bấm, chỉ xê dịch vừa đủ (lên/xuống trước, sang ngang sau, tối đa khoảng một hàng) nếu chạm thẻ khác — không còn trượt xuống tận cuối một cột dài cảnh hay thẻ nhân vật. Không có chỗ trống gần đó thì giữ đúng chỗ bấm. Khi vùng đang nhìn không có cảnh nào, cảnh mới vào chỗ trống gần giữa màn hình nhất **trong vùng nhìn**.
- Khung nhìn **chỉ trượt vừa đủ** để thấy node mới và **giữ nguyên mức zoom**. Trước đây canvas tự phóng to lên 80% và nhảy tới node mới nên mọi thứ khác như bị dời đi xa.
- `N` khi đang chọn cảnh: cảnh mới nằm ngay dưới cảnh đó. Chỉ những thẻ **thật sự bị đè** mới được đẩy xuống, và chỉ vừa đủ. Cột bên cạnh (cách 16 px) không còn bị đẩy theo.
- Video đã kéo ra chỗ khác hoặc đang ẩn (chế độ "Chỉ take chọn") không còn làm cảnh tiếp theo bị đẩy xuống thấp. **Sắp xếp** vẫn chừa chỗ cho video đang ẩn, nên bật lại "Tất cả" thì không video nào đè hàng dưới.
- Video mới của một cảnh nằm ngay cạnh cảnh, không xếp sau các video đã kéo đi chỗ khác (trước đây video thứ 10 có thể nằm cách thẻ cảnh hơn 2.000 px). Video chỉ hơi xê dịch thì vẫn giữ chỗ của nó trong hàng.
- **Tạo cảnh tiếp nối** từ một video đã kéo ra chỗ khác: cảnh mới nằm ngay bên phải video đó. Video chỉ hơi xê dịch hoặc đổi cỡ tại chỗ (vẫn trong hàng của cảnh): cảnh mới nằm dưới cảnh gốc như trước, không chắn chỗ của video tiếp theo.
- **Đưa lên canvas** từ thư viện: thẻ mới vào đúng cột nhân vật, không chạy theo một thẻ lẻ đã kéo ra xa, và không đè thẻ nằm lệch cạnh cột. Thả nhiều thẻ cùng lúc: xếp thành hàng 4 thẻ, thẻ nào đã có trên canvas thì giữ nguyên chỗ.
- Nhập prompt hàng loạt: các cảnh mới xếp ngay dưới cảnh bạn vừa làm.

🛠️ **Thông báo chuyển lên trên**
- Thông báo hiện ở **giữa phía trên**, ngay dưới thanh trên cùng, thông báo mới nhất ở trên cùng. Không còn che thanh công cụ canvas (+ Cảnh, Chạy, Sắp xếp, zoom…) và hàng đợi ở dưới.

🛠️ **Chạy tối đa 10 video cùng lúc qua canvasapp** (trước đây 2)
- Từ video thứ 11 trở đi thì chờ trong hàng đợi.
- Vẫn nhẹ nhàng với máy chủ: tiến độ của mọi video được kiểm tra chung **một lần** (≥ 15 giây/lần), gửi từng video một, tối đa 2 yêu cầu + 2 lượt tải video cùng lúc. Tải video về không còn làm chậm việc kiểm tra tiến độ hay gửi video mới.
- Video đang tạo **không bao giờ bị gỡ** khỏi canvas cầu nối trên canvasapp để lấy chỗ cho video mới. Khi canvas đã kín (40 node / 30 ảnh — vd. nhiều cảnh, mỗi cảnh 4 nhân vật khác nhau), video mới **chờ trong hàng đợi** tới khi một video xong rồi tự gửi; chưa gửi thì không bị trừ credit.
- Video chờ gửi hiện đúng là "đang chờ" (gửi lần lượt từng cái): huỷ lúc này thì chắc chắn không bị trừ credit, và nếu app bị đóng giữa chừng thì nhiều nhất một video bị đánh dấu "không rõ đã trừ credit chưa".

## [0.2.4] — 2026-10-02

🐞 **Tag ảnh viết kiểu `@Image 1` giờ được nhận đúng** (sửa gấp)
- Prompt viết `@Image 1`, `@image 2`, `@image3`, `@IMAGE_4` (chữ hoa / thường, có dấu cách, gạch dưới hoặc viết liền) được hiểu **giống hệt** `@image_1`.
- Các tag này được **tô màu**, được kiểm tra có ảnh thật đi kèm hay không, và **tự đánh lại số** khi đổi thứ tự ảnh. App giữ nguyên cách bạn viết: `@Image 1` → `@Image 3`.
- Trước đây các tag này bị bỏ qua: không tô màu, và khi đổi thứ tự ảnh thì số không được sửa theo, nên có thể **trỏ nhầm nhân vật**.
- Tag trong ô prompt nổi bật hơn: nền màu đậm hơn và có viền mảnh cùng màu.

🛠️ **Ô tên cảnh gọn lại**
- Thẻ cảnh chưa đặt tên không còn hiện khối "Chưa đặt tên" to. Rê chuột lên thẻ mới hiện dòng chữ nhỏ "Bấm đúp để đặt tên". Tên đã đặt hiện gọn trên một dòng.

🛠️ Thư mục `release/` tự gọn sau mỗi lần build: ngoài cùng chỉ còn bản mới nhất, bản cũ nằm trong `release/ban-cu/<phiên bản>/`.

## [0.2.3] — 2026-10-02

✨ **Trình phát mini ngay trên node Video**
- Rê chuột lên node để xem video có tiếng. Thanh điều khiển ở đáy video gồm:
  - **thanh thời gian**: bấm hoặc kéo để tua, hiện giờ tại vị trí chuột;
  - **phát / dừng**;
  - **tốc độ**: 0,5×, 0,75×, 1×, 1,25×, 1,5×, 2×;
  - **âm lượng**: bấm loa để tắt/bật, kéo thanh hoặc lăn chuột để chỉnh.
- Đã bấm vào điều khiển thì video **giữ mở** kể cả khi chuột rời node; bấm ra chỗ trống trên canvas để đóng. Rê sang node khác thì video đang mở tự dừng, nên không bao giờ hai video cùng kêu.
- Mở lại node thì video phát tiếp từ chỗ đang xem.
- Âm lượng và tốc độ được nhớ trên máy, dùng chung với cửa sổ xem take. Phát liền ở Storyboard dùng chung âm lượng, giữ tốc độ thường.

🐞 **Sửa lỗi**
- Cài đặt › Cổng canvasapp: dòng "Đã đăng nhập canvasapp" không còn bị bóp méo hay đè chữ khi cửa sổ hẹp; các nút tự xuống dòng riêng.

## [0.2.2] — 2026-10-02

✨ **Xem video có tiếng**
- Xem trước khi rê chuột lên node, cửa sổ xem take và **Phát liền** ở Storyboard giờ phát có tiếng. Trước đây cả ba đều tắt tiếng cố định.
- Có nút loa để bật/tắt tiếng, một công tắc dùng chung và được nhớ trên máy.
- Bản desktop cho phép video tự phát có tiếng. Bản web: nếu trình duyệt chặn tiếng khi chưa bấm gì thì video phát không tiếng, bấm loa một lần là có tiếng.

## [0.2.1] — 2026-10-02

🐞 **Sửa lỗi "Invalid canvas payload" khi gửi sang canvasapp.io.vn**
- Canvas cầu nối và yêu cầu tạo video giờ gửi **đúng định dạng của trang canvasapp gốc**:
  - trường khung nhìn (viewport) đúng tên;
  - node video chỉ còn 6 trường dữ liệu và đúng kích thước;
  - mã node và mã yêu cầu dạng UUID, cố định theo cảnh / theo take;
  - khung cuối mang số thứ tự 2.
- Canvas bị canvasapp từ chối không còn làm hỏng các lần gửi sau.
- Thông báo lỗi ghi rõ yêu cầu nào, mã lỗi HTTP và chi tiết từng trường, để dễ báo lỗi.
- App đọc danh sách model / chế độ canvasapp đang mở trước khi gửi.
- Tổng số ảnh trên canvas cầu nối giữ trong giới hạn 30 như trang gốc, ảnh dùng chung một node.
- Hết credit thì không tải lại ảnh không cần thiết sau khi nạp.

⚠️ Đây là bản đầu tiên tạo video thật thành công qua canvasapp (đã thử với credit thật).

## [0.2.0] — 2026-10-02

✨ **Cổng canvasapp.io.vn (chỉ bản desktop, thử nghiệm)**
- Đăng nhập trên trang thật của canvasapp trong cửa sổ riêng. SanoVids không bao giờ thấy mật khẩu.
- Tạo video bằng tài khoản canvasapp của chính bạn, trừ **credit thật**.
- Ô credit tách bạch **DEMO** (credit giả lập) và **canvasapp** (credit thật).

✨ **Nạp credit trong app**
- Nút **+** cạnh ô credit, hoặc Cài đặt → **Nạp credit**. Thanh toán bằng **QR SePay**, bạn tự quét.
- App chỉ mở trang của sepay.vn và chỉ báo "Đã nhận tiền" khi canvasapp xác nhận.
- Xem **Lịch sử credit** trong app.

✨ **Đồng bộ nhân vật chặt chẽ**
- `@image_N` không có ảnh thật đi kèm thì bị tô đỏ và chặn nút Chạy. Các trường hợp: vượt số ảnh, vượt giới hạn của model, chế độ không gửi ảnh, dấu chờ `@image_?N`.
- Take gửi đúng bộ ảnh chụp lúc bấm Chạy.
- "Viết prompt trước, nối ảnh sau" vẫn khớp số.
- Có cảnh báo khi tắt "tự đánh lại số".

✨ **An toàn tiền** (đã thử toàn bộ với canvasapp giả lập)
- Mất mạng lúc gửi: không bao giờ tự gửi thành job mới. Gửi lại dùng cùng mã yêu cầu và tìm job cũ trước.
- Video đã trả tiền mà tải về lỗi thì app tự thử tải lại.
- Đổi dự án, xoá cảnh hay huỷ không làm mất job hoặc gửi nhầm job.

🐞 **Sửa lỗi giao diện**
- Kéo một thẻ mới thêm vào cảnh không còn nối cả loạt thẻ vừa thêm.
- Bấm `C` không kéo theo các thẻ đã chọn từ trước trong thư viện.
- "Chạy lại" và "Thử lại" luôn qua bảng chi phí, bấm đúp không bị chạy hai lần.
- Nút Chạy khoá kèm lý do khi cảnh chưa chạy được.

📄 Danh sách tự kiểm tra với credit thật: [docs/TEST-REAL-CREDITS.md](docs/TEST-REAL-CREDITS.md).

⚠️ **Lỗi đã biết:** gửi sang canvasapp bị từ chối "Invalid canvas payload" (không trừ credit). Đã sửa ở **0.2.1**. Đừng dùng bản này cho cổng canvasapp.

## [0.1.0] — 2026-10-02

Bản `.exe` đầu tiên. Gồm toàn bộ quá trình làm từ bản demo đầu tiên (chỉ có nhà cung cấp video giả lập).

**2026-10-01: bản demo đầu tiên**
- ✨ Canvas node: cảnh, thư viện nhân vật / bối cảnh / đạo cụ, nối ảnh tham chiếu bằng dây hoặc kéo thả, **nối hàng loạt** (`C`).
- ✨ Hàng đợi chạy giả lập, bảng xác nhận chi phí, **Bảng cảnh**, **Storyboard** (Phát liền), hoàn tác / làm lại.

**v2: node Video & `@image_N` / `@video_N`**
- ✨ Mỗi lần tạo video sinh ra một **node Video** nối từ cảnh. Kéo node Video sang cảnh khác để dùng làm `@video_N`, thả ra chỗ trống để tạo **cảnh tiếp nối**.
- 🛠️ Bỏ khối prompt và đoạn tham chiếu tự động. Prompt gửi đúng như viết, ảnh đánh số `@image_1`, `@image_2`… và **tự đánh lại số** khi đổi tham chiếu.
- ✨ Lưu bằng IndexedDB, cài như app (PWA), đóng gói **file `.exe`** cho Windows. Kéo đổi độ rộng hai thanh bên.

**Tải video & đổi tên**
- ✨ Nút **"Tải video"** to dưới mỗi node, tải hàng loạt (.zip), tự tải khi tạo xong.
- 🛠️ Đổi tên ứng dụng thành **SanoVids**. Ảnh đại diện vuông, **đổi kích thước node**.
- 🐞 Không tự tham chiếu video của chính cảnh. Huỷ xoá thì không xoá gì. Khôi phục take đánh lại số đúng.

**Web & ảnh tham chiếu**
- ✨ Bản web trên Cloudflare Workers.
- 🐞 Nối (C) không còn nối thừa ảnh: chọn 3 ảnh thì chỉ nối 3, không gộp lựa chọn cũ trong thư viện.
- ✨ Ảnh tham chiếu hiện **đủ cả tấm theo đúng tỉ lệ** (canvas, thư viện, inspector), cửa sổ phóng to ảnh, xem trước khi rê chuột.

**Giao diện kiểu Apple**
- ✨ Giao diện kiểu Apple, chế độ **Sáng / Tối / Theo hệ thống**.
- 🐞 Rà soát lỗi toàn app, kiểm chứng từng lỗi.
- 🛠️ Nền tảng cổng canvasapp (tắt mặc định).

[0.5.0]: https://github.com/JameSteven404/sanovids-releases/releases/tag/v0.5.0
[0.4.2]: https://github.com/JameSteven404/sanovids/releases/tag/v0.4.2
[0.4.1]: https://github.com/JameSteven404/sanovids/releases/tag/v0.4.1
[0.4.0]: https://github.com/JameSteven404/sanovids/releases/tag/v0.4.0
[0.3.0]: https://github.com/JameSteven404/sanovids/releases/tag/v0.3.0
[0.2.5]: https://github.com/JameSteven404/sanovids/releases/tag/v0.2.5
[0.2.4]: https://github.com/JameSteven404/sanovids/releases/tag/v0.2.4
[0.2.3]: https://github.com/JameSteven404/sanovids/releases/tag/v0.2.3
[0.2.2]: https://github.com/JameSteven404/sanovids/releases/tag/v0.2.2
[0.2.1]: https://github.com/JameSteven404/sanovids/releases/tag/v0.2.1
[0.2.0]: https://github.com/JameSteven404/sanovids/releases/tag/v0.2.0
[0.1.0]: https://github.com/JameSteven404/sanovids/releases/tag/v0.1.0
