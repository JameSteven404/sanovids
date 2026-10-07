# 🎬 SanoVids

**SanoVids** là ứng dụng dạng *canvas node* để làm phim AI theo từng cảnh: quản lý nhân vật, nối ảnh tham chiếu vào cảnh, viết prompt với `@image_1`, `@video_1`, chạy tạo video hàng loạt, rồi lấy video vừa tạo để nối tiếp sang cảnh sau.

👤 Tác giả: **Nguyễn Giang Minh (Jame Steven)** · Đồng hành: Sano Group

📥 **[Tải bản mới nhất (.exe)](https://github.com/JameSteven404/sanovids-releases/releases/latest)** · 📜 **[Lịch sử phiên bản](CHANGELOG.md)** · 🔄 Bản cài **tự cập nhật** từ 0.5.0 · 🔐 **Ký số** bởi tác giả

Ứng dụng được thiết kế lại từ trải nghiệm thực tế với các công cụ canvas tạo video (Seedance 2.5, MiniMax-H3), để **nối node nhanh hơn, ít rối dây hơn và không lệch số tham chiếu**. SanoVids là **ứng dụng desktop cho Windows** (file `.exe`).

> 🖥️ **Chỉ còn bản app.** Từ 2026-10-02 bản web (sanovids.sanovids.workers.dev) đã **ngừng và tắt hẳn**. Mọi tính năng mới và bản sửa lỗi chỉ phát hành cho bản desktop — tải ở [trang tải về](https://github.com/JameSteven404/sanovids-releases/releases/latest).

> ℹ️ **Hai cách tạo video:**
> - **Chế độ Phát triển** (mặc định): chạy **đúng mã của cổng canvasapp thật** nhưng tới một **canvasapp.io.vn giả lập ngay trong app** — không gọi mạng, không tốn tiền (credit dev giả lập). Có đủ đăng nhập, credit, nạp credit qua SePay giả, lịch sử credit, và **Bảng phát triển** để gây lỗi có chủ đích, xem nhật ký từng yêu cầu — dùng để làm quen và **tìm, sửa lỗi** trước khi dùng tiền thật. Xem mục [Chế độ Phát triển](#-chế-độ-phát-triển-tìm-và-sửa-lỗi).
> - **Cổng canvasapp.io.vn** (thử nghiệm, **chỉ bản desktop `.exe`**): tạo video thật bằng **tài khoản canvasapp của chính bạn**, trừ **credit thật**. Xem mục [Tạo video thật qua canvasapp.io.vn](#-tạo-video-thật-qua-canvasappiovn-bản-desktop).

---

## ✨ Tính năng chính

### Canvas & nối node
- **Mỗi lần tạo video sinh ra một node Video** nối từ cảnh, xếp ngay bên phải cảnh. Có **nút "⬇ Tải video" to** ở dưới mỗi node.
- **Kéo node Video sang cảnh khác** để dùng làm video tham chiếu `@video_1` (nối tiếp câu chuyện). Thả ra chỗ trống để **tạo cảnh tiếp nối**: giữ nhân vật, prompt bắt đầu bằng `Continue from @video_1:`.
- **Kéo dây từ nhân vật thả vào bất kỳ đâu trên thẻ cảnh** để nối ảnh tham chiếu. Kéo nhân vật từ Thư viện vào cảnh cũng được.
- **Nối hàng loạt**: chọn nhiều nhân vật hoặc video cùng nhiều cảnh rồi bấm `C`.
- **Dây ẩn mặc định**, chỉ hiện dây của cảnh đang chọn hoặc đang trỏ chuột vào (đổi được: Ẩn / Đang chọn / Tất cả).
- **Bấm vào dây là cắt** (có Hoàn tác), hoặc phím `Delete`. Kéo đầu dây sang cảnh khác để nối lại. Hoạt ảnh kéo và cắt dây mượt, giảm được trong Cài đặt.
- **Dây luôn chạm đúng tâm chấm tròn**: nhiều dây vào một cảnh thì chụm gọn vào một chấm, không xoè rộng. Chấm tham chiếu của cảnh mang màu của dây nối vào (xanh ngọc = ảnh, tím = video, hai màu khi có cả hai).
- **Hoàn tác / Làm lại** (`Ctrl+Z` / `Ctrl+Y`), bản đồ thu nhỏ, sắp xếp tự động.
- **Node mới hiện ngay cạnh chỗ bạn đang làm**: cảnh mới nằm ngay dưới cảnh bạn vừa chọn (hoặc trong vùng đang nhìn), không đè lên thẻ khác; khung nhìn chỉ trượt vừa đủ để thấy node mới, **giữ nguyên mức zoom**. Thông báo hiện ở **giữa phía trên**, ngay dưới thanh trên cùng, không che thanh công cụ canvas.
- Chế độ "Chỉ take chọn" chỉ hiện video ★ của mỗi cảnh cho gọn.
- Kéo đổi độ rộng hai thanh bên (bấm đúp để về mặc định).

### Viết prompt với `@image_N` / `@video_N`
- Prompt gửi đi **đúng như bạn viết**. Ảnh nối vào cảnh được đánh số `@image_1`, `@image_2`… theo thứ tự nối; video tham chiếu là `@video_1`, `@video_2`…. Viết `@Image 1`, `@image1` hay `@IMAGE_1` cũng được hiểu y như `@image_1`.
- Gõ `@` để chọn nhanh: ảnh đã nối, video đã nối, hoặc nhân vật chưa nối (ứng dụng tự nối rồi chèn số).
- **Tự đánh lại số**: khi đổi thứ tự hoặc bỏ một ảnh/video, mọi `@image_N` / `@video_N` trong prompt được sửa theo, để không bị lệch nhân vật.
- Token được tô màu ngay trong ô prompt. Số không có ảnh thật trong lần gửi (vượt số ảnh, vượt giới hạn của model, hoặc dấu chờ `@image_?N`) tô đỏ và **chặn nút Chạy**, để không bao giờ gửi nhầm nhân vật. Dưới ô có bảng chú giải ảnh ↔ số.
- Viết prompt trước rồi nối ảnh sau cũng được: `@image_1`, `@image_2` sẽ khớp với các nhân vật nối vào theo thứ tự.
- Take đã bấm Chạy luôn gửi đúng bộ ảnh lúc bấm, dù bạn sửa thư viện trong lúc chờ.
- Cảnh báo khi thiếu tham chiếu, vượt giới hạn ảnh/video của model, prompt quá dài.
- **Copy prompt** và **Tải ảnh + video + prompt (.zip)** đã đánh số đúng thứ tự.
- **Nhập prompt cũ**: dán nhiều prompt hoặc thả các file `.txt` để tạo cảnh hàng loạt. Có thể gán ảnh thư viện cho từng số `@image_N`.

### Chạy video & tải về
- **Preset** (ví dụ *Nháp 30s · 480p*, *Final 15s · 1080p*), áp dụng cho nhiều cảnh một lần.
- **Chạy hàng loạt** với bảng xác nhận chi phí (ghi rõ trừ **credit dev** (giả lập) hay **credit canvasapp** (thật)), hàng đợi chạy song song, cập nhật tiến độ trực tiếp. Mọi nút Chạy / Chạy lại / Thử lại đều qua bảng chi phí, bấm đúp không bị chạy hai lần.
- Nút Chạy bị khoá kèm lý do khi cảnh chưa chạy được (prompt trống, thiếu ảnh, `@image_N` không có ảnh thật…).
- **Cấu hình video theo canvasapp**: model / chế độ / thời lượng / độ phân giải / tỉ lệ mà canvasapp đang tắt hiện mờ kèm lý do và không chọn được; cảnh đang dùng chúng chưa chạy được (bị bỏ qua khi chạy nhiều cảnh, không tốn credit). Cấu hình đã lưu của cảnh không bị đổi. Chưa đọc được cấu hình từ canvasapp thì chỉ cảnh báo "có thể bị từ chối"; bấm **Đọc lại** để cập nhật ngay.
- Đánh dấu ★ take chọn, khôi phục prompt của take cũ.
- **Tải video**: một nút cho từng video (kèm file `.txt` chứa prompt), **"Tải tất cả video chọn (.zip)"**, hoặc bật **Tự tải video khi tạo xong** vào thư mục bạn chọn.
- Video đã tạo xong được kéo về app từng phần: take hiện **"Đang tải về …%"**. Bấm **Huỷ** (hoặc **Xoá**) lúc này thì app **hỏi trước** (video đã xong và đã trừ credit; huỷ / xoá chỉ bỏ nó trong SanoVids, chạy lại cảnh sẽ trừ credit lần nữa).

### Lưu video
- **Tải video…** mở hộp **Save As** của Windows để chọn nơi lưu và **đổi tên**. File `.txt` prompt được lưu cạnh video (tắt được trong Cài đặt).
- **Đổi tên video đầu ra** ngay trên node video hoặc trong cửa sổ xem take. Có **mẫu đặt tên** (`{scene}`, `{take}`, `{title}`, `{date}`…) trong Cài đặt → Nâng cao.
- **Node Thư mục**: nối **video → Thư mục** để chép vào đó; nối **cảnh → Thư mục** để mọi video mới của cảnh tự lưu vào khi xong. Không ghi đè file có sẵn.

### Xem video
- **Rê chuột lên node Video** để xem ngay trên canvas, **có tiếng**. Thanh điều khiển ở đáy video: **thanh thời gian** (bấm hoặc kéo để tua), **phát/dừng**, **tốc độ** (0,5× → 2×), **âm lượng** (bấm loa để tắt/bật, kéo thanh hoặc lăn chuột để chỉnh).
- Đã bấm vào điều khiển thì video **giữ mở** kể cả khi chuột rời node; bấm ra chỗ trống trên canvas để đóng. Rê sang node khác thì video đang mở tự dừng (không bao giờ hai video cùng kêu).
- Âm lượng, tốc độ và bật/tắt tiếng được **nhớ trên máy**, dùng chung cho node, cửa sổ xem take và **Phát liền** ở Storyboard.

### Các màn hình khác
- **Bảng cảnh**: xem dạng bảng, sắp xếp thứ tự, sửa hàng loạt.
- **Storyboard**: các cảnh theo thứ tự kèm take đã chọn, **kéo-thả để sắp xếp lại** (hoặc Alt + mũi tên), nút **Phát liền**.
- **Cài đặt** chia **Cơ bản / Nâng cao**, có ô tìm kiếm, sao lưu / khôi phục cài đặt. **Cài đặt → Giới thiệu**: phiên bản, tác giả, bản quyền và trạng thái chữ ký số của app.
- Nhiều dự án; xuất/nhập `.sanovids.json` (kèm ảnh) để sao lưu hoặc chuyển máy.
- Giao diện kiểu Apple, chế độ **Sáng / Tối / Theo hệ thống**.

---

## 🧪 Chế độ Phát triển (tìm và sửa lỗi)

Mặc định SanoVids chạy ở **chế độ Phát triển**: mọi bước của chế độ thật — đăng nhập, đọc số dư, tải ảnh tham chiếu lên, lưu canvas cầu nối, tạo job, theo dõi tiến độ, tải video về, nạp credit qua SePay, lịch sử credit — đều chạy bằng **chính mã của cổng canvasapp**, nhưng nói chuyện với một **canvasapp.io.vn giả lập nằm ngay trong app**. Không có yêu cầu mạng nào, không tốn tiền.

**Nhận biết:** ô credit trên thanh trên cùng có viền nét đứt và chữ **DEV** (ví dụ `DEV 1.000 credit`), mọi chi phí ghi **credit dev**, node Video có nhãn **DEV**. Credit dev **không phải tiền thật**.

**Dùng thử như thật**
- Lần đầu: bấm **DEV · Đăng nhập** → trang đăng nhập **giả lập** hiện ra (không cần mật khẩu) → **Đăng nhập**. Tài khoản giả lập có sẵn **1.000 credit dev**.
- Chạy cảnh như bình thường: video giả dài 3 giây, ghi nhãn **`@image_1`, `@image_2`…** lên từng ảnh tham chiếu **theo đúng thứ tự canvasapp nhận** — nhìn là biết có gửi đúng nhân vật không. Mặc định video xong sau khoảng 8 giây (đổi sang “Thực tế” 60–90 giây trong Bảng phát triển).
- Nút **+** cạnh ô credit → **Mở thanh toán QR** → trang **SePay giả lập** hiện ra trong app: bấm **Thanh toán thành công / Huỷ / Lỗi thanh toán / Đóng cửa sổ** để thử từng trường hợp.

**Bảng phát triển** (nút 🐞 trên thanh trên cùng, hoặc **Cài đặt → Chế độ Phát triển**):
- **Trạng thái**: đăng nhập / đăng xuất / hết phiên phía máy chủ, đặt số dư (+100, −100, về 0, về 1.000), tốc độ tạo video, bật/tắt nạp credit, chống trùng job, mã lỗi khi hết credit (402/400), độ trễ mạng, tỉ lệ job tự lỗi, bật/tắt từng model và chế độ, xoá dữ liệu máy chủ giả lập.
- **Gây lỗi**: bấm một nút để lần yêu cầu tới bị lỗi (bật “giữ” để lặp lại tới khi tắt): mất mạng khi tạo job, **mất câu trả lời sau khi đã tạo job (đã trừ tiền)**, 502, 200 không có mã job, không đủ credit (402), dữ liệu sai (422), “Invalid canvas payload”, hết phiên (401), quá nhiều yêu cầu (429), job tiếp theo lỗi / hết hạn, tải video lỗi N lần, tải ảnh lên lỗi, chậm 3 giây… hoặc tự tạo lỗi cho bất kỳ yêu cầu nào. Nút 🐞 hiện số lỗi giả đang bật để không nhầm với lỗi thật.
- **Nhật ký**: mọi yêu cầu SanoVids gửi đi và câu trả lời (mã, thời gian, lỗi giả đã áp dụng), mở ra xem JSON; lọc; **Copy nhật ký** (JSON) để gửi kèm khi báo lỗi. Với mỗi lần tạo job có ô **Kiểm tra nhân vật**: từng ảnh theo thứ tự = `@image_N` → ảnh và tên nhân vật trong dự án, và cảnh báo nếu prompt nhắc `@image_N` mà không có ảnh.
- **Job & đơn nạp**: job trên máy chủ giả lập (tiến độ, chi phí, đã hoàn chưa, thuộc take nào) với **Hoàn tất ngay / Cho lỗi / Cho hết hạn**; đơn nạp với **Đã thanh toán / Cần đối soát / Từ chối / Hết hạn**; ảnh đã tải lên.

**Cách tìm lỗi:** bật một lỗi → làm thao tác bình thường (chạy cảnh, nạp credit, đăng nhập) → xem SanoVids báo gì, take có giữ đúng trạng thái không, credit có bị trừ hai lần không → mở **Nhật ký** xem từng yêu cầu → **Copy nhật ký** gửi kèm báo lỗi. Chế độ Phát triển cũng từ chối đúng những gì canvasapp từ chối (ảnh không phải JPG/PNG/WEBP, video tham chiếu `@video_N`, prompt quá dài…).

---

## 🔌 Tạo video thật qua canvasapp.io.vn (bản desktop)

> 🧪 **Thử nghiệm.** Cổng dùng API nội bộ của trang canvasapp.io.vn (không phải API công khai), có thể thay đổi bất cứ lúc nào. Nên hỏi ý bên vận hành canvasapp trước khi dùng lâu dài.

**Bật cổng**
1. Mở bản **desktop** (`.exe`) → **Cài đặt** → **Cổng canvasapp.io.vn**.
2. Bấm **Đăng nhập canvasapp**: trang đăng nhập **thật** của canvasapp mở trong cửa sổ riêng, bạn tự đăng nhập ở đó. **SanoVids không bao giờ thấy mật khẩu.**
3. Chọn **canvasapp.io.vn** ở "Nhà cung cấp video cho take mới". Ô credit trên thanh trên cùng đổi từ **DEV** (giả lập) sang **canvasapp · số credit thật**.

**Credit & nạp credit**
- Số dư đọc trực tiếp từ tài khoản canvasapp (1 credit ≈ 1.000đ). Bảng chi phí trước khi chạy dùng đúng bảng giá của canvasapp.
- Nút **+** cạnh ô credit (hoặc **Cài đặt → Nạp credit**): nhập số tiền → **Mở thanh toán QR** → trang **SePay** mở trong cửa sổ riêng → **bạn tự quét QR** bằng app ngân hàng. SanoVids chỉ cho mở trang của sepay.vn, không nhập hay thấy thông tin ngân hàng, và chỉ báo **"Đã nhận tiền"** khi chính canvasapp xác nhận.
- **Lịch sử credit** xem ngay trong app.

**An toàn tiền & đúng nhân vật**
- `@image_N` luôn là đúng tấm ảnh thứ N gửi đi (thứ tự tải lên = thứ tự `@image`). Mỗi ảnh chỉ tải lên canvasapp một lần.
- Mất mạng đúng lúc gửi: SanoVids **không tự gửi lại thành job mới**. App chờ khoảng 45 giây để chắc danh sách job của canvasapp đã hiện job đó (nếu có) — trong lúc ấy các cảnh khác trong hàng đợi chờ theo; không thấy thì gửi lại **một lần** bằng **cùng mã yêu cầu**, vẫn không rõ thì take hiện "không rõ đã bị trừ chưa". Bấm gửi lại thì app tìm job cũ trên canvasapp trước, rồi mới gửi lại bằng cùng mã yêu cầu — nếu lần gửi trước có thể vẫn đang tới canvasapp (vd. trang vừa tải lại đúng lúc gửi), app chưa gửi lại: take chờ tới lúc chắc chắn rồi tự tìm lại.
- **Huỷ** một take đang gửi: take vẫn "có thể đã bị trừ" cho tới khi biết chắc; **Thử lại** khi đó gửi lại **chính take đó** (tìm job cũ trước), không bao giờ thành take mới trả thêm.
- Video đã tạo xong (đã trả tiền) mà tải về lỗi thì app tự thử tải lại (tải tiếp từ chỗ dừng khi canvasapp cho), không đánh "thất bại". Trừ hai trường hợp không bao giờ tải được: video **lớn hơn 1 GB**, hoặc một kết nối quá **60 phút** mà không tải tiếp được — take báo lỗi ngay, ghi rõ **đã trừ credit** và tải video trực tiếp trên canvasapp.io.vn (phiên "SanoVids bridge").
- Đóng app khi đang tạo: mở lại, app tìm lại job cũ và tiếp tục theo dõi. Chắc chắn lần gửi đó chưa tạo job (mở lại ngay sau đó) → app gửi lại bằng cùng mã yêu cầu; mở lại lâu sau (job có thể đã bị xoá trên canvasapp) → take hiện "không rõ", app không tự gửi lại — kiểm tra trên canvasapp rồi bấm Chạy lại.

**Nhập job (video tạo trực tiếp trên canvasapp)**
- Đã bấm "Tạo video" trên node của một cảnh trong phiên **"SanoVids bridge"** trên canvasapp.io.vn? Bấm **Nhập job** (thanh trên của **Hàng đợi**, hoặc **Cài đặt › Nhà cung cấp video** khi đã đăng nhập) → các job đó hiện dưới đúng cảnh → **Nhập N job**: mỗi job thành một take của cảnh, video tự về khi xong.
- **Chỉ đọc, không trừ credit** (video đã trả khi tạo trên trang). Take nhập có chip **nhập**; điều canvasapp không cho biết hiện **"?"**, điều chỉ đoán theo node hiện **"≈"**. **Chạy lại** một take nhập tạo **take mới** và trừ credit như thường.
- Ở chế độ Phát triển: **Bảng phát triển › Job & đơn nạp › Tạo job như trên trang canvasapp**, rồi Nhập job như trên.

**Giới hạn hiện tại**
- Tối đa 10 job cùng lúc (job thứ 11 trở đi chờ trong hàng đợi), cập nhật tiến độ khoảng 20 giây/lần.
- **Chưa hỗ trợ video tham chiếu** `@video_N` qua cổng (cả chế độ Phát triển cũng từ chối giống vậy; chưa thấy canvasapp nhận video): bỏ video tham chiếu khỏi cảnh (nút × trong inspector hoặc cắt dây) để chạy cảnh tiếp nối — chỉ xoá chữ `@video_N` thì chưa đủ. Cảnh MiniMax-H3 ở chế độ không gửi video (Text → Video, Khung đầu → cuối) vẫn chạy dù còn nối video, miễn là prompt không còn chữ `@video_N` (cảnh tiếp nối bắt đầu bằng `Continue from @video_1:`: xoá chữ đó đi).
- App dùng một phiên tên **"SanoVids bridge"** trên canvasapp để gửi job. **Chạy** một node ở đó (bấm "Tạo video") thì được — đưa video đó vào dự án bằng **Nhập job** (xem trên). **Sửa** node ở đó thì bị ghi đè ở lần gửi sau của SanoVids: nhập job trước khi chạy lại cảnh đó trong SanoVids, và đóng tab phiên này trước khi chạy cảnh trong SanoVids.
- Huỷ trong SanoVids chỉ ngừng theo dõi: job đã gửi vẫn chạy và tính tiền trên canvasapp.

👉 Lần đầu dùng credit thật: tập dượt miễn phí bằng chế độ Phát triển trước, rồi làm theo danh sách tự kiểm tra (tốn khoảng 8 credit): [docs/TEST-REAL-CREDITS.md](docs/TEST-REAL-CREDITS.md).

---

## 💻 Cài trên Windows (file .exe)

Vào **[trang tải về](https://github.com/JameSteven404/sanovids-releases/releases/latest)** (hoặc thư mục `release/` sau khi tự build), chọn phiên bản mới nhất. Mỗi phiên bản có 2 file:

| File | Dùng khi |
|---|---|
| `SanoVids-Setup-<phiên bản>.exe` | **Khuyên dùng.** Bộ cài đặt: hiện **Giấy phép sử dụng**, chọn thư mục, tạo icon ở Desktop và Start Menu, **tự cập nhật** các bản sau. |
| `SanoVids-Portable-<phiên bản>.exe` | Bấm là chạy, không cần cài (mở chậm hơn vì phải tự giải nén mỗi lần). Hợp để chép USB. Không tự cập nhật (app chỉ báo có bản mới). |

> 🛡️ Cả hai file đều được **ký số** bởi **Nguyễn Giang Minh (Jame Steven)** — kiểm tra trước khi chạy: chuột phải file → **Properties** → **Digital Signatures** (xem [Chữ ký số & bảo mật](#-chữ-ký-số--bảo-mật)). Chứng chỉ là chứng chỉ tự ký, nên Windows SmartScreen báo **"Windows protected your PC"** với file tải bằng trình duyệt (bản nào cũng vậy, cảnh báo không tự mất theo thời gian): bấm **More info**, xem nhà phát hành rồi **Run anyway**. Bản tự cập nhật thì không bị hỏi.

Trang tải về còn có `latest.yml` và `SanoVids-Setup-<phiên bản>.exe.blockmap` (file app dùng để tự cập nhật, bạn không cần tải) và `SanoVids-NguyenGiangMinh.cer` (chứng chỉ công khai của tác giả, để kiểm tra chữ ký).

- Dữ liệu của bản desktop nằm ở `%APPDATA%\SanoVids` trên từng máy. Muốn mang dự án sang máy khác, dùng **Cài đặt → Xuất dự án** rồi **Nhập** ở máy kia.
- Video tải về được lưu vào thư mục **Downloads**, hoặc thư mục bạn chọn trong Cài đặt.

### Bản web / PWA (đã ngừng)
Bản web và bản cài từ trình duyệt (PWA) **không còn được cập nhật** và địa chỉ web đã tắt. Nếu máy bạn còn biểu tượng SanoVids cài từ trình duyệt, hãy gỡ nó và dùng bản `.exe`. `npm run dev` vẫn chạy được trên máy để phát triển.

---

## 🔄 Cập nhật tự động

Từ bản **0.5.0**, bản cài (Setup) tự cập nhật — không phải tải và cài lại bằng tay mỗi lần có bản mới.

- **Tự tìm và tải trong nền**: SanoVids kiểm tra bản mới khi mở app (sau khoảng 15 giây) và **4 giờ một lần**. Có bản mới thì tải về trong nền, bạn cứ làm việc bình thường. Thường chỉ tải phần thay đổi; bản nào đổi phiên bản Electron (lõi của app) thì phải tải gần như cả bộ cài.
- **Cài lúc nào bạn muốn**: tải xong, thanh trên cùng hiện nút xanh lá **Cập nhật x.y.z** (cửa sổ hẹp hoặc đang có video chạy: chỉ còn mũi tên và số phiên bản). Bấm vào để xem **Có gì mới** rồi chọn **Khởi động lại để cập nhật** (SanoVids lưu dự án, cài bản mới, tự mở lại). Chọn **Để sau** thì bản mới **tự cài khi bạn tắt SanoVids**.
- **Cập nhật khi xong**: đang có video tạo dở thì chọn nút này — SanoVids đợi hết video đang tạo / đang chờ (và lượt nạp credit), báo trước 5 giây (huỷ được) rồi mới khởi động lại. Cập nhật ngay cũng an toàn: video đang tạo vẫn chạy trên máy chủ và được theo dõi lại sau khi mở lên, không bị trừ credit hai lần.
- **Cài đặt → Cập nhật**: phiên bản đang dùng, trạng thái, lần kiểm tra gần nhất, nút **Kiểm tra ngay**, công tắc **Tự động tải bản cập nhật** (tắt thì app chỉ báo có bản mới, bạn bấm để tải).
- **Cài cho mọi người dùng** (lúc cài chọn "Anyone who uses this computer", thư mục `Program Files`): mỗi lần cập nhật Windows sẽ hỏi quyền quản trị (UAC) — kể cả khi bản mới tự cài lúc bạn tắt SanoVids. Bấm **Có** để cài; từ chối thì vẫn dùng bản cũ và lần sau app sẽ thử lại. Cài "Only for me" (mặc định) thì không bị hỏi.
- **Vừa tắt app để cài bản mới**: đợi khoảng 15 giây rồi hãy mở lại SanoVids.
- **Bản Portable chỉ báo có bản mới** (nút **Tải bản mới** mở trang tải về), không tự cài. Muốn tự cập nhật, hãy dùng bản Setup.
- **Bản 0.4.2 trở về trước** chưa biết tự cập nhật: cài tay `SanoVids-Setup-0.5.0.exe` (hoặc mới hơn) **một lần**, cài đè lên bản cũ; dự án và cài đặt giữ nguyên.
- **An toàn**: bản cập nhật chỉ được cài khi mang **đúng chữ ký số của tác giả** (dấu vân tay chứng chỉ ghim sẵn trong app) và đúng là phiên bản mới được báo (không bao giờ quay về bản cũ). File không có chữ ký, ký bởi người khác (kể cả trùng tên), sai phiên bản hay đã bị sửa đều bị xoá, không cài, và không được tự tải lại; app báo lỗi. Khi đó **đừng tự tải bản đó về cài**: chỉ cài bộ cài có dấu vân tay trùng với **Cài đặt → Giới thiệu**, hoặc hỏi tác giả. Máy chặn không cho kiểm tra chữ ký (PowerShell bị khoá…) thì app chưa cài và tự thử lại sau. Ngoài ra bản cập nhật chỉ tải qua HTTPS từ [trang tải về](https://github.com/JameSteven404/sanovids-releases/releases/latest) và phải khớp mã **SHA-512** ghi trong `latest.yml`.
- **Riêng tư**: mỗi lần kiểm tra, app gửi cho GitHub một **mã cài đặt ngẫu nhiên** (`x-user-staging-id`, tạo một lần trên máy), không gửi gì từ dự án của bạn. Không cần tài khoản GitHub.

Chi tiết kỹ thuật và cách phát hành: [docs/UPDATES.md](docs/UPDATES.md).

---

## 🔐 Chữ ký số & bảo mật

- **Mọi file `.exe` chính thức** (Setup, Portable, `SanoVids.exe` bên trong, trình gỡ cài đặt) được ký số bởi **Nguyễn Giang Minh (Jame Steven)**, kèm dấu thời gian (chữ ký vẫn hợp lệ sau khi chứng chỉ hết hạn).
  Dấu vân tay chứng chỉ: **`7489ABFAC1A7CD23D5FFB0785CA7CAB414AE49ED`**. File không mang đúng chữ ký này **không phải bản gốc**: đừng chạy.
- **Cách kiểm tra**: chuột phải file `.exe` → **Properties** → tab **Digital Signatures** → chọn **Nguyễn Giang Minh (Jame Steven)** → **Details** → **View Certificate** → tab **Details** → dòng **Thumbprint** phải đúng dấu vân tay ở trên. Không có tab Digital Signatures = file chưa ký, không phải bản chính thức.
- **So dấu vân tay với một nguồn khác trang tải về**: tác giả gửi trực tiếp (chat nội bộ, gặp mặt), hoặc dòng dấu vân tay trong **Cài đặt → Giới thiệu** của một SanoVids đã cài từ trước. Đừng chỉ tin dấu vân tay in trên trang tải về: ai chiếm được trang đó thay được cả file lẫn dấu vân tay.
- **"Unknown publisher" là bình thường**: chứng chỉ do tác giả tự ký (không mua của tổ chức cấp chứng chỉ), nên UAC ghi nhà phát hành là **Unknown publisher**, và SmartScreen hiện **"Windows protected your PC"** với mỗi file tải bằng trình duyệt (cảnh báo này không tự mất theo thời gian). Điều quan trọng là dấu vân tay khớp.
  Máy trong nhóm nội bộ có thể chạy **`tin-cay-chung-chi.ps1`** (ở [trang tải về](https://github.com/JameSteven404/sanovids-releases)) một lần: script kiểm tra dấu vân tay rồi thêm **phần công khai** của chứng chỉ vào kho *Trusted Root Certification Authorities* của Windows (cho tài khoản đang dùng; `-TatCaNguoiDung` cho mọi tài khoản, cần quyền quản trị). Windows hỏi xác nhận trước khi thêm. Sau đó UAC hiện đúng tên tác giả (SmartScreen thì vẫn cảnh báo như cũ). Script không thêm vào *Trusted Publishers* (kho đó cho script / macro ký bằng chứng chỉ này chạy không hỏi; SanoVids không cần). `-KiemTra` để xem, `-Go` để gỡ. Không bắt buộc: SanoVids vẫn chạy và tự cập nhật bình thường khi chưa tin cậy.
- **Bản cập nhật chỉ được nhận khi ký bởi đúng chứng chỉ đó** (ghim theo dấu vân tay, không theo tên). Sai là xoá, không cài.
- **App tự kiểm tra chữ ký của file chương trình**: **Cài đặt → Giới thiệu** hiện **"Đã ký số bởi Nguyễn Giang Minh (Jame Steven) ✓"** khi `SanoVids.exe` và các DLL chính đi kèm (`ffmpeg.dll`…) còn chữ ký gốc, hoặc cảnh báo khi chúng bị sửa, ký bởi người khác hay không có chữ ký.
- **Chống can thiệp**: mã của app (`app.asar`) bị sửa thì SanoVids **không mở**, hoặc **tự tắt** khi mở tới màn hình dùng phần bị sửa. File chương trình `SanoVids.exe` hay một DLL chính bị sửa / bị thay thì Windows vẫn cho chạy, nhưng **Giới thiệu** báo **"File của SanoVids đã bị thay đổi"** / **"Không phải bản gốc"**. Các file khác trong thư mục cài (`.pak`, `locales`, một DLL lạ đặt thêm vào…) không được kiểm tra. Gặp một trong các trường hợp đó → tải bộ cài ở trang tải về và cài lại (cài đè, dự án và cài đặt giữ nguyên). Đây là lớp chống sửa nhầm / hỏng file và giúp nhận ra bản không chính thức, không thay được phần mềm diệt virus: chương trình độc đã chạy bằng tài khoản của bạn vẫn sửa được thư mục cài.
- SanoVids từ chối mở khi bị chạy kèm tham số gỡ lỗi / tắt bảo mật (ví dụ `--remote-debugging-port`, `--inspect`, `--no-sandbox`), và tắt công cụ nhà phát triển (DevTools) trong bản cài.

Chi tiết cho người phát triển (cách ký, sao lưu khoá, đổi chứng chỉ, bảng quyết định): [docs/SIGNING.md](docs/SIGNING.md).

---

## 🚀 Chạy từ mã nguồn

### Yêu cầu
- [Node.js](https://nodejs.org/) **20 trở lên** (khuyến nghị bản LTS mới nhất)
- [Git](https://git-scm.com/)

### Cách nhanh nhất (Windows)
- **`start.bat`**: build (nếu chưa có) rồi mở bản chạy thật tại http://localhost:5180. Sau khi sửa code, xoá thư mục `dist/` hoặc chạy `npm run build` để cập nhật.
- **`dev.bat`**: bản phát triển, tự tải lại khi sửa code.

### Dòng lệnh
```bash
git clone https://github.com/JameSteven404/sanovids.git
cd sanovids
npm install
npm run dev
```

| Lệnh | Tác dụng |
|---|---|
| `npm run dev` | Bản phát triển tại http://localhost:5180 |
| `npm run build` | Kiểm tra kiểu và build giao diện vào `dist/` (bản desktop đóng gói thư mục này) |
| `npm run preview` | Chạy thử bản đã build |
| `npm run desktop` | Build rồi mở bản desktop (Electron) trên máy |
| `npm run dist:win` | Tạo 2 file `.exe` **đã ký số** (cài đặt + portable) trong `release/`, file tự cập nhật (`latest.yml`, `.blockmap`) trong `release/_build/`; bản cũ tự chuyển vào `release/ban-cu/`. Cần khoá ký của tác giả trên máy và có mạng ([docs/SIGNING.md](docs/SIGNING.md)) |
| `npm run release:check` | Xem trước việc đăng bản: kiểm tra tag, file, nguồn cập nhật, GitHub và in đúng các lệnh sẽ chạy (không đăng gì) |
| `npm run release:publish` | Đăng bản lên GitHub: repo riêng `sanovids` trước, trang tải về công khai `sanovids-releases` sau cùng (chỉ chủ dự án) |
| `npm run icons` | Tạo lại icon ứng dụng |
| `node scripts/third-party-notices.mjs` | Tạo lại giấy phép của các thư viện mã nguồn mở (`build/license-third-party.txt` → `THIRD-PARTY-NOTICES.txt` trong thư mục cài). Chạy sau khi thêm / nâng thư viện: `npm test` báo nếu file đã cũ |
| `npm run typecheck` / `npm test` | Kiểm tra TypeScript / chạy unit test |

> 💾 Dữ liệu được lưu **ngay trên máy** (trong app desktop, thư mục `%APPDATA%\SanoVids`), không gửi đi đâu.

### Phát hành bản mới (chỉ chủ dự án)
1. Viết mục `## [x.y.z] — ngày — tiêu đề` ở đầu `CHANGELOG.md` (đây cũng là phần **Có gì mới** người dùng thấy trong app) và đổi `version` trong `package.json`.
2. Merge vào `main`.
3. Trên `main`: `git tag -a vX.Y.Z -m "SanoVids X.Y.Z"` rồi `git push origin vX.Y.Z`.
4. `npm run dist:win` (build sau khi tag, để ngày build mới hơn commit). Máy build phải có khoá ký trong `Cert:\CurrentUser\My`, thiếu là build dừng ([docs/SIGNING.md](docs/SIGNING.md)).
5. `npm run release:check`: mọi dòng phải là ✓ (⚠ chỉ để lưu ý). Đổi chứng chỉ ký thì phải theo đúng "ghim trước, ký sau" ([docs/SIGNING.md](docs/SIGNING.md) mục 7), kiểm tra này chặn nếu làm tắt.
6. `npm run release:publish`: tạo bản nháp → tải file lên → kiểm tra SHA-256 → đăng repo riêng rồi mới đăng trang tải về công khai. Bị ngắt giữa chừng thì chạy lại, an toàn.

Chi tiết: [docs/UPDATES.md](docs/UPDATES.md).

---

## ⌨️ Phím tắt

| Phím | Tác dụng |
|---|---|
| `N` | Tạo cảnh mới / cảnh tiếp theo (bên dưới cảnh đang chọn) |
| `C` | Nối nhân vật hoặc video đang chọn vào các cảnh đang chọn |
| `Ctrl + Enter` | Chạy các cảnh đang chọn |
| `Ctrl + D` | Nhân bản cảnh |
| `Delete` | Xoá cảnh / video / cắt dây đang chọn |
| `Ctrl + Z` / `Ctrl + Y` | Hoàn tác / Làm lại |
| `Ctrl + A` | Chọn tất cả cảnh |
| `F` | Vừa màn hình |
| `E` | Đổi chế độ hiện dây nối |
| `H` / `V` | Công cụ Tay / Chọn |
| `M` | Bật/tắt bản đồ thu nhỏ |
| `1` `2` `3` | Canvas / Bảng cảnh / Storyboard |
| `Ctrl + K` | Tìm trong thư viện |
| `Ctrl + S` | Lưu ngay |
| `?` | Xem toàn bộ phím tắt |

---

## 🗂️ Cấu trúc thư mục

```
src/
├── core/          # Mô hình dữ liệu, xử lý prompt & đánh số @image/@video, model & giá, di trú dữ liệu (+ test)
├── store/         # Trạng thái: dự án (có hoàn tác), hàng đợi/take, giao diện, lưu trữ IndexedDB
├── lib/           # Lưu ảnh/video, tải về, kéo-thả, PWA, giao diện sáng/tối, phát video, credit
├── providers/     # Nhà cung cấp video: cổng canvasapp.io.vn (api, ánh xạ, cầu nối desktop), dev/ = canvasapp giả lập
│                  #   của chế độ Phát triển (máy chủ, cầu nối, lỗi giả, nhật ký), mock = demo cũ
├── components/
│   ├── canvas/    # Canvas: thẻ cảnh, node Video, thẻ nhân vật, dây nối, thanh công cụ
│   ├── sidebar/   # Thư viện, Video đã tạo, Preset
│   ├── inspector/ # Bảng chỉnh sửa, ô prompt có gợi ý @ và tô màu token
│   ├── runs/      # Hàng đợi, xác nhận chạy, xem take
│   ├── views/     # Bảng cảnh, Storyboard
│   ├── dialogs/   # Nhập prompt, cài đặt (cổng canvasapp), dự án, phím tắt
│   ├── topbar/    # Thanh trên cùng, ô credit (DEV / canvasapp)
│   ├── topup/     # Nạp credit (QR SePay; SePay giả lập ở chế độ Phát triển), lịch sử credit
│   ├── dev/       # Bảng phát triển, trang đăng nhập / SePay giả lập
│   └── common/    # Modal, thông báo, ảnh, kéo đổi độ rộng
├── actions.ts     # Lệnh dùng chung (nối, xoá, chạy, tải, copy…)
└── App.tsx        # Khung ứng dụng
electron/          # Vỏ ứng dụng desktop (Electron), cửa sổ đăng nhập / thanh toán canvasapp, tự cập nhật (updater),
                   #   kiểm tra chữ ký số (signature), chống can thiệp (hardening-rules)
scripts/           # Build & phát hành: build có ký số, dọn release/, ghi chú cập nhật, kiểm tra bản build, đăng bản lên GitHub,
                   #   icon, giấy phép thư viện mã nguồn mở; signing/ = sao lưu / khôi phục khoá ký, tin cậy chứng chỉ;
                   #   releases-repo/ = trang tải về công khai
build/             # Icon, ảnh bộ cài, giấy phép (license_vi.txt, license-third-party.txt), chứng chỉ công khai (signing/*.cer)
public/            # Icon, manifest PWA
docs/              # Đặc tả (SPEC.md, SPEC-v2.md), cổng canvasapp, tự kiểm tra credit thật, tự cập nhật (UPDATES.md),
                   #   chữ ký số & chống can thiệp (SIGNING.md)
```

## 🛠️ Công nghệ
[Vite](https://vite.dev) · [React 19](https://react.dev) · TypeScript · [React Flow](https://reactflow.dev) · [Zustand](https://zustand.docs.pmnd.rs) + zundo · lucide-react · idb-keyval · JSZip · vite-plugin-pwa · [Electron](https://www.electronjs.org/) + electron-builder + electron-updater · Vitest

---

## 🧭 Lộ trình
Chi tiết từng phiên bản: [CHANGELOG.md](CHANGELOG.md).

- [x] v1: canvas, thư viện, nối hàng loạt, hàng đợi giả lập, bảng cảnh, storyboard
- [x] v2: node Video, `@image_N` / `@video_N` tự đánh số, bỏ khối prompt, IndexedDB, PWA, file `.exe`, nút tải video
- [x] v0.2 (thử nghiệm): cổng canvasapp.io.vn trong bản desktop (đăng nhập trên trang thật, credit thật, nạp credit bằng QR SePay), khoá chặt đồng bộ nhân vật, xem video có tiếng + thanh điều khiển ngay trên node. Tự kiểm tra trước khi dùng: [docs/TEST-REAL-CREDITS.md](docs/TEST-REAL-CREDITS.md)
- [x] Chế độ Phát triển thay cho demo: canvasapp giả lập trong app với đủ tính năng của chế độ thật, Bảng phát triển (gây lỗi, nhật ký, kiểm tra nhân vật, điều khiển job / đơn nạp)
- [x] Tự cập nhật phiên bản (0.5.0)
- [x] Ký số file .exe (0.5.0): bản cập nhật chỉ nhận chữ ký của tác giả, app tự kiểm tra chữ ký, chống can thiệp, icon mới
- [ ] Video tham chiếu `@video_N` qua cổng canvasapp (chờ ghi lại cách trang canvasapp gửi video, nếu có: [docs/canvasapp-api-notes.md](docs/canvasapp-api-notes.md))
- [ ] Kết nối API thật (BytePlus ModelArk cho Seedance 2.5, MiniMax cho H3) qua lớp *provider adapter*, có giới hạn chi tiêu
- [ ] So sánh nhiều take cạnh nhau, ghép cả phim thành một MP4

## 👤 Tác giả
**Nguyễn Giang Minh (Jame Steven)** — tác giả và người phát triển SanoVids.
Đồng hành: Sano Group.

Bản quyền © 2026 Nguyễn Giang Minh (Jame Steven). Giấy phép: [LICENSE.txt](LICENSE.txt). Bản chính thức chỉ có ở [trang tải về](https://github.com/JameSteven404/sanovids-releases/releases).

## 📄 Giấy phép
SanoVids **không phải phần mềm mã nguồn mở**. Tóm tắt [LICENSE.txt](LICENSE.txt) (bộ cài cũng hiện toàn văn trước khi cài, và file này nằm trong thư mục cài đặt):
- SanoVids thuộc quyền sở hữu của tác giả **Nguyễn Giang Minh (Jame Steven)**. Mọi quyền được bảo lưu.
- Được cài và dùng **khi được tác giả cho phép** (ví dụ: trong nội bộ nhóm làm việc). Tải được từ trang công khai không có nghĩa là được phép dùng.
- **Không** được sao chép, chỉnh sửa, dịch ngược, tháo rời, phân phối lại, cho thuê hoặc bán lại SanoVids (toàn bộ hay một phần) khi chưa có đồng ý bằng văn bản của tác giả.
- Bản cài chính thức luôn được ký số bởi "Nguyễn Giang Minh (Jame Steven)", dấu vân tay `7489ABFAC1A7CD23D5FFB0785CA7CAB414AE49ED`. Bản không mang chữ ký này không phải bản gốc.
- Phần mềm được cung cấp "nguyên trạng", không kèm bảo đảm nào; tác giả không chịu trách nhiệm về thiệt hại phát sinh khi sử dụng.
- Các thành phần mã nguồn mở (Electron, Chromium, React…) theo giấy phép riêng của chúng, được kèm trong thư mục cài đặt (`LICENSE.electron.txt`, `LICENSES.chromium.html`, và `THIRD-PARTY-NOTICES.txt` cho các thư viện và phông chữ khác: tạo bằng `node scripts/third-party-notices.mjs` từ `node_modules`, lưu ở `build/license-third-party.txt`).
