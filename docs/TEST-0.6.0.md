# Tự kiểm tra SanoVids 0.6.0

Danh sách dành cho người làm phim, dùng trên **bản cài Windows (Setup)** và **bản Portable**. Đây là các bước cần thử, chưa phải kết quả đã đạt. “Take” là một lần tạo video của một cảnh; “job” là lượt tạo video ở canvasapp.

Đối chiếu mã ngày 07/10/2026, mốc `0d7f3cb`. Những phần đang làm có ghi **(khi bản thử có tính năng này)**. Nếu bản nhận được chưa có, ghi **Chưa có** rồi bỏ qua. Đừng đánh dấu Đạt cho mục chưa thử.

## Cách ghi kết quả và chuẩn bị

Làm từng nhóm trên Setup rồi lặp lại trên Portable; riêng bước 4 làm xen kẽ hai bản theo đúng thứ tự ghi trong bước. Đóng hẳn bản trước rồi mới mở bản sau. Hai bản có thể dùng chung cài đặt trên cùng tài khoản Windows; đừng coi Portable là một bộ dữ liệu riêng.

Ghi kết quả theo mẫu này; mỗi lỗi thêm một dòng:

| Bước | Setup: Đạt / Lỗi / Chưa thử / Chưa có | Portable: Đạt / Lỗi / Chưa thử / Chưa có | Ghi chú |
|---|---|---|---|
| … | … | … | Phiên bản, thao tác cuối, thông báo nguyên văn, ảnh chụp |

Các bước sửa cảnh, thư viện, giao diện không cần tạo video. Các bước cần video có sẵn **trong dự án thử** (xem video 35–39, đổi tên và lưu 37, Phát liền 45, ngắt dây Thư mục 63, các lệnh cho video ở thanh công cụ và menu): dự án mới hoặc bản sao không có video nào, xem bước 2. Không có video trong dự án thử thì ghi **Chưa thử**; **không bao giờ làm các bước này trên dự án phim thật**.

**Hộp xác nhận chi phí** chỉ mở khi cổng canvasapp.io.vn đã bật (Cài đặt → Nhà cung cấp video, đọc cảnh báo rồi bật; chưa cần đăng nhập) hoặc đang chọn **Phát triển (giả lập)**. Mở hộp rồi bấm Huỷ không tạo job, không trừ credit. Nếu chưa, Ctrl+Enter / **Tạo video** / **Chạy** hiện thông báo “Chưa bật cổng canvasapp.io.vn — mở Cài đặt → Nhà cung cấp video để bật.” kèm nút **Mở Cài đặt**: đó là kết quả đúng, không phải lỗi. Thẻ cảnh vẫn có thể ghi **Tạo video · … credit**.

Các bước **[DEV]** chỉ dành cho chủ ứng dụng đã mở khoá, đang chọn **Phát triển (giả lập)** và thấy **DEV / credit dev**. Chưa mở được thì ghi Chưa thử. **Không chuyển bài gây lỗi sang credit thật.**

Các bước **[Tài khoản thật]** cần đăng nhập do bạn tự thực hiện. Chỉ tạo video thật nếu bạn chủ động đồng ý chi phí ở hộp xác nhận. Không cần nạp tiền để hoàn thành danh sách này. Giá trong [bài thử credit thật cũ](TEST-REAL-CREDITS.md) chỉ là ví dụ của bài đó; hãy đọc giá đang hiện trong bản thử. Cách mở DEV và giao diện ở bài cũ có thể đã khác.

1. **Nhận diện bản đang thử.** Mở Cài đặt → Giới thiệu; ghi phiên bản, Setup hay Portable, phiên bản Windows và ngày giờ thử. **Đúng:** nhận diện đúng bản bạn mở. Nếu vẫn ghi 0.5.0, ghi nguyên số đó và mã bản thử người làm app cung cấp. **Nếu lỗi:** chụp Giới thiệu và ghi tên file đã mở.

2. **Chuẩn bị dự án thử.** Trước khi thử, tải về các video bạn cần giữ của dự án phim (Tải video, .zip hoặc Thư mục): file **Xuất dự án** (Cài đặt → Dữ liệu dự án, `.sanovids.json`) chỉ chứa cảnh, prompt và ảnh, **không chứa video đã tạo**. Sau đó xuất dự án phim làm bản sao cảnh/prompt/ảnh. Tạo dự án riêng “Thử 0.6.0”; thêm ba ảnh, mỗi thẻ một ảnh: “Elara”, “Lumi”, “Làng”; tạo ba cảnh.
   **Video cho dự án thử:** dự án mới, bản sao (Nhân bản) hay dự án nhập từ file xuất đều **không có video nào**; Nhập job cũng chỉ lấy job đã tạo trên trang canvasapp cho chính các cảnh của dự án đang mở, không mang video từ dự án phim sang. Cách an toàn để có vài video mẫu (nên có cả ngang và dọc): chủ ứng dụng dùng **[DEV]** Phát triển (giả lập, chỉ trừ credit dev); hoặc bạn tự chủ động tạo một take thật trong dự án thử sau khi đọc giá ở hộp xác nhận. Không làm được thì ghi **Chưa thử** cho các bước cần video. **Đúng:** ảnh mở được, dự án phim gốc không bị sửa. **Nếu lỗi:** ghi thao tác, file không nhập được và thông báo. Không xoá dữ liệu app để làm lại bài thử.

3. **Lưu rồi mở lại.** Đổi tên một cảnh, gõ prompt, lưu và đóng hẳn app rồi mở lại. **Đúng:** còn đúng dự án, tên, chữ và ảnh đã thêm. **Nếu lỗi:** ghi phần mất, thời điểm đóng và trạng thái lưu lúc đó. Dừng bài thử trên bản này nếu mất dữ liệu.

## Đăng nhập canvasapp và đăng xuất

Setup và Portable dùng chung lựa chọn của công tắc giữ đăng nhập. Mặc định (bật ở Setup, tắt ở Portable) chỉ thấy được khi **chưa từng tự chọn** công tắc trên máy này, nên làm bước 4 **trước** bước 5–7: các bước đó lưu lựa chọn của bạn và từ đó cả hai bản theo lựa chọn ấy. Nếu đã từng chọn, ghi Chưa thử cho phần mặc định ở bước 4 và ghi lại trạng thái công tắc đang thấy. Không xoá cấu hình đang dùng để làm lại.

4. **[Tài khoản thật] Mặc định của hai bản, trước khi đụng công tắc.** Làm đúng thứ tự, đóng hẳn app sau mỗi phần; **không bấm** công tắc **Giữ đăng nhập canvasapp trên máy này** trong bước này. Chỉ kiểm tra tài khoản, chưa bấm tạo video.
   (a) Mở **Setup**: Cài đặt → Nhà cung cấp video / Cổng canvasapp.io.vn, đọc cảnh báo rồi bật cổng; ghi trạng thái công tắc; đăng nhập; ghi số dư. Đóng hẳn, mở lại Setup và ghi còn đăng nhập hay không. Đóng hẳn.
   (b) Mở **Portable**, vào cùng chỗ đó: ghi trạng thái công tắc và còn đăng nhập hay không. Đóng hẳn.
   (c) Mở lại **Setup**: ghi còn đăng nhập hay phải đăng nhập lại.
   **Đúng:** ở (a) công tắc bật, app báo đã đăng nhập, số dư khớp tài khoản và mở lại vẫn còn đăng nhập; ở (b) công tắc tắt và Portable chưa đăng nhập (Portable không dùng bản đăng nhập Setup đã giữ). Ở (c) Setup **vẫn còn đăng nhập**, không phải đăng nhập lại: Portable chưa tự chọn thì chỉ không dùng và không lưu bản đăng nhập, không xoá bản Setup đã giữ. Chỉ khi bạn tự tắt công tắc (bước 6), bấm Đăng xuất (bước 7) hoặc bản giữ quá 30 ngày thì bản đó mới bị xoá. Nếu ở (c) phải đăng nhập lại là lỗi; đừng tự sửa cấu hình. **Nếu lỗi:** ghi phần (a)/(b)/(c), loại bản, công tắc đã từng đổi chưa, thời điểm và thông báo; không gửi mật khẩu hay dữ liệu phiên đăng nhập.

5. **[Tài khoản thật] Thử giữ phiên qua lần mở lại.** Bật công tắc giữ đăng nhập, đăng nhập nếu cần, đóng hẳn rồi mở lại app. Làm trên cả hai bản. **Đúng:** còn tài khoản và số dư, không phải đăng nhập lại. Phiên được giữ tối đa 30 ngày, hoặc ngắn hơn nếu canvasapp kết thúc phiên; máy không mã hoá được phải báo rõ. **Nếu lỗi:** ghi thời gian giữa hai lần mở và thông báo cạnh công tắc.

6. **[Tài khoản thật] Thử tắt giữ phiên.** Tắt công tắc khi đang đăng nhập; kiểm tra ngay rồi đóng hẳn và mở lại. **Đúng:** phiên hiện tại vẫn dùng được sau khi tắt; lần mở sau cần đăng nhập lại. Portable chưa đổi lựa chọn cũng phải đăng nhập lại ở lần mở sau, nhưng khác bước này ở chỗ không xoá bản đăng nhập Setup đã giữ (xem bước 4). **Nếu lỗi:** ghi tài khoản còn hay mất ở thời điểm nào.

7. **[Tài khoản thật] Đăng xuất.** Khi không có lượt thật đang gửi hoặc tải, bật giữ đăng nhập rồi bấm Đăng xuất; mở lại app. **Đúng:** vẫn đã đăng xuất, không tự phục hồi tài khoản cũ. Nếu đăng nhập tài khoản khác, số dư phải thuộc tài khoản mới. Nếu bạn đăng nhập canvasapp bằng Google, lần đăng nhập Google sau trong SanoVids hỏi lại mật khẩu Google: đó là thiết kế (app xoá cookie tài khoản Google sau khi canvasapp xác nhận đăng nhập), không phải lỗi. **Nếu lỗi:** ghi hai thời điểm, nhãn tài khoản và số dư; che thông tin cá nhân trong ảnh.

## Chế độ Phát triển chỉ chủ ứng dụng mở được

8. **Kiểm tra lúc đang khoá.** Mở thanh trên cùng và tìm “dev”, “phát triển” trong Cài đặt. **Đúng:** không có nút Bảng phát triển hay lựa chọn giả lập cho take mới. Video DEV cũ vẫn được nhận diện là DEV và xem được; không biến thành video trả tiền. **Nếu lỗi:** chụp chỗ còn lộ hoặc take bị đổi nhãn. Không thử bằng cách xác nhận một lượt chạy thật.

9. **Chủ ứng dụng mở khoá.** Cài đặt → Giới thiệu → bấm dòng phiên bản **5 lần trong 3 giây**. Lần đầu, trên máy chính đã có khoá chủ ứng dụng, dùng công cụ **Tao ma mo khoa.bat** trong `scripts/owner` để lấy mã **SV1-…** cho đúng “Mã máy này”, rồi dán vào hộp. Máy đã liên kết thì dùng mã 6 số từ mục tương ứng trong app xác thực. **Đúng:** hộp mở khoá báo kết quả và thời hạn. Mã SV1 chỉ dùng một lần; bản này không có bước tự gửi mã Gmail. **Nếu lỗi:** ghi mã máy và thông báo, không gửi mã SV1, mã 6 số, khoá hay ảnh QR.

10. **Chọn giả lập sau khi mở khoá.** Nếu được mời liên kết app xác thực, chủ ứng dụng làm theo hộp hướng dẫn trong 5 phút. Sau đó tự chọn **Phát triển (giả lập)** trong Nhà cung cấp video. **Đúng:** mở khoá không tự đổi nhà cung cấp; chỉ sau khi chọn giả lập mới thấy DEV / credit dev. **Nếu lỗi:** ghi nhà cung cấp trước và sau, không chạy bài gây lỗi khi còn chữ canvasapp thật.

11. **[DEV] Khoá lại.** Khi không còn bài giả lập đang chạy, dùng **Khoá lại ngay**. **Đúng:** Bảng phát triển và hộp giả lập đóng, các mục DEV lại ẩn; app không gửi một take DEV thành lượt thật. Mở khoá lại nếu cần làm các bước [DEV] tiếp theo. **Nếu lỗi:** ghi hộp nào còn mở hoặc take nào đổi nhà cung cấp.

## Sửa ngay trên thẻ cảnh

12. **Mở dòng cấu hình.** Bấm dòng model / thời lượng / độ phân giải / tỉ lệ ngay trên thẻ cảnh. Đổi một thông số và bộ cấu hình có sẵn (preset). **Đúng:** sửa được ngay trên thẻ, dòng tóm tắt và giá tạo video đổi theo. Cấu hình canvasapp đã xác nhận không nhận phải bị chặn và có lý do. **Nếu lỗi:** ghi model, chế độ, thông số trước/sau và chỗ không đổi.

13. **Gõ prompt.** Bấm vào chữ trên thẻ, gõ tiếng Việt có dấu; bấm Enter để xuống dòng, Esc để rời ô; chọn lại thẻ rồi Enter để gõ tiếp. **Đúng:** chữ không mất khi rời ô, không tạo cảnh hay xoá thẻ ngoài ý muốn. Khi danh sách gợi ý `@` đang mở, Enter chọn gợi ý. **Nếu lỗi:** ghi đoạn chữ và chuỗi phím gây lỗi, bộ gõ đang dùng.

14. **Kiểm tra nút chạy.** Cần cổng canvasapp.io.vn đã bật (chưa cần đăng nhập) hoặc đang chọn Phát triển (giả lập); nếu không, xem lại phần “Hộp xác nhận chi phí” ở đầu danh sách. Để prompt trống, rồi điền prompt hợp lệ. **Đúng:** lúc trống hiện lý do chưa chạy; đủ điều kiện hiện **Tạo video · … credit** (thẻ chật có thể chỉ hiện giá). Ctrl+Enter khi đang gõ áp dụng cho đúng cảnh đó và mở hộp xác nhận chi phí. Bấm Huỷ ở hộp này. **Nếu lỗi:** ghi cảnh đang sửa, cảnh trong hộp, nhãn nút và giá; việc mở rồi huỷ hộp không tạo job.

15. **Giữ chữ đang gõ.** Gõ thêm một câu, chuyển sang cảnh khác rồi quay lại; lưu, đóng app và mở lại. **Đúng:** câu cuối vẫn còn, ô prompt trên thẻ và bảng bên phải cùng nội dung. **Nếu lỗi:** ghi câu bị mất, cách rời ô và trạng thái lưu.

## Cắt ảnh giữ chữ đỏ, chưa gắn lại thì chưa chạy

16. **Cắt ảnh Lumi.** Nối Elara, Lumi, Làng theo thứ tự vào một cảnh và gõ `@image_1 ôm @image_2 trước @image_3`. Cắt dây Lumi bằng cách cắt dây đang dùng trong app. **Đúng:** chỗ Lumi thành chữ đỏ **`@image_?2(Lumi)`**; câu không mất đoạn đó. Khi bật tự đánh số, Làng đổi thành `@image_2`; Lumi vẫn là chỗ trống, không tự trỏ sang Làng. Sau khi cắt, chọn cảnh này và nhân bản (Ctrl+D): bản sao giữ nguyên chữ đỏ để dùng ở bước 20; các bước 17–19 làm trên cảnh gốc. **Nếu lỗi:** chụp prompt và thứ tự ảnh trước/sau; dừng chạy cảnh nếu số trỏ sai người.

17. **Thử chặn chạy.** Khi còn chữ đỏ, kiểm tra nút trên thẻ và lệnh chạy ở bảng bên phải. **Đúng:** cảnh bị chặn, thẻ ghi **Chưa chạy · còn chữ đỏ**; không có job mới, không giảm credit. **Nếu lỗi:** ghi đường bấm đã cho chạy và tên ảnh còn thiếu.

18. **Gắn ảnh đúng chỗ.** Dùng dải **Chữ đỏ chờ ảnh**, chọn Lumi rồi gắn ảnh đã nối phù hợp; cũng thử kéo ảnh vào chỗ chữ đỏ trên thẻ. **Đúng:** số ảnh trong prompt trỏ tới ảnh bạn vừa chọn, chữ đỏ hết khi đã điền đủ, nút chạy mở lại nếu không còn lỗi khác. Nối một ảnh mới không có nghĩa là tự điền mọi chỗ đỏ. **Nếu lỗi:** ghi tên ảnh thả, chỗ nhận và số `@image` sau khi gắn.

19. **Hoàn tác và bỏ nhân vật có chủ ý.** Ctrl+Z sau khi gắn lại, rồi thử **Đổi thành chữ “Lumi”** ở dải chữ đỏ. **Đúng:** hoàn tác khôi phục chỗ chờ; đổi thành chữ giữ tên Lumi như văn bản thường, không còn hứa gửi ảnh Lumi. Nếu có nhiều chỗ chờ, các chỗ khác vẫn chặn chạy. **Nếu lỗi:** ghi prompt trước/sau và số lần hoàn tác.

20. **Không lách nhầm bằng cách xoá dấu hỏi.** Trên bản sao cảnh đã tạo ở cuối bước 16 (nếu chưa có, chọn cảnh gốc và Ctrl+Z tới khi `@image_?2(Lumi)` trở lại), khi số 2 đang là Làng, đổi `@image_?2(Lumi)` thành `@image_2(Lumi)`. **Đúng:** vẫn đỏ và bị chặn vì tên Lumi không khớp ảnh số 2; app không gửi Làng thay Lumi. Hoàn tác sau khi thử. **Nếu lỗi:** chụp chữ và danh sách ảnh, không xác nhận chạy.

21. **Chọn cách gắn ngay trong ô prompt (khi bản thử có tính năng này).** Trên một cảnh còn chữ đỏ (bản sao của bước 20 sau khi đã Hoàn tác, hoặc Ctrl+Z trên cảnh gốc), bấm vào chữ đỏ trong ô prompt trên thẻ cảnh và trong ô prompt ở bảng bên phải; thử bằng chuột rồi bằng bàn phím (Tab, mũi tên, Enter, Esc). Sau đó nối một ảnh từ Thư viện vào cảnh, lần lượt bằng nút nối của thẻ Thư viện và bằng cách kéo thẻ Thư viện vào cảnh. **Đúng:** chữ đỏ mở lựa chọn **Gắn ảnh đã nối…**, **Đổi thành chữ**, **Xoá chữ đỏ**, không mở danh sách gợi ý `@`; mỗi lựa chọn đã bấm là một lần Hoàn tác, Esc đóng mà không đổi gì. Nối từ Thư viện hiện gợi ý **Gắn vào chỗ …** và chỉ gắn khi bạn bấm; app không bao giờ tự gắn theo tên. **Nếu lỗi:** ghi ô prompt nào, phím hoặc cách bấm, prompt trước/sau.

22. **Thay ảnh bằng kéo đầu dây (khi bản thử có tính năng này).** Thêm ảnh thứ tư “Mira” vào canvas. Nối Elara, Lumi vào một cảnh mới với prompt `@image_1 ôm @image_2`. Kéo đầu dây **phía ảnh** của dây Lumi → cảnh sang thẻ Mira; Ctrl+Z; rồi thử thả đầu dây đó ra nền trống. Nếu có thẻ nhiều ảnh, thử thay nó bằng một thẻ chỉ có một ảnh. **Đúng:** số 2 giờ là Mira, prompt không đổi chữ nào, có thông báo kèm Hoàn tác; một lần Ctrl+Z trả lại Lumi; thả ra chỗ không hợp lệ thì dây giữ nguyên và không có gì thay đổi. Ảnh mới ít tấm hơn thì chỗ thiếu thành chữ đỏ `@image_?N(…)`, không mất chữ. **Nếu lỗi:** chụp prompt và danh sách ảnh trước/sau, ghi đầu dây đã kéo và chỗ thả; không chạy cảnh nếu số trỏ sai người.

## Bỏ video tham chiếu

23. **Mở bản sao dự án cũ có `@video_1`.** Dùng bản sao (Nhân bản, hoặc Xuất dự án rồi Nhập) của một dự án 0.5 có chữ `@video` trong prompt. Bản sao **không có video nào** và không giữ dây video cũ: đó là bình thường, không phải mất dữ liệu. **Đúng:** lần đầu mở bản sao, thông báo cho biết số cảnh còn chữ @video, nút **Xem** chọn đúng các cảnh đó. Chữ `@video` được giữ nguyên, tô đỏ, cảnh đó không chạy cho đến khi bạn sửa; không còn điều khiển thêm video tham chiếu hay dây video → cảnh. Ở bảng bên phải, nút **Xoá @video_1** chỉ xoá chữ đó, Ctrl+Z trả lại; chọn nhiều cảnh thì có **Xoá chữ @video ở N cảnh đang chọn**. **Nếu lỗi:** ghi cảnh, chụp prompt và thông báo; giữ nguyên file dự án gốc.
   **Phần chỉ có ở dự án gốc:** video đã tạo và các cảnh từng nối video mà prompt không nhắc `@video` (nay chạy được và chỉ gửi ảnh) chỉ thấy trên chính dự án gốc. Chỉ kiểm tra khi đã cài 0.6.0 để làm phim (bước 65–66), hoặc khi bạn chấp nhận mở dự án gốc bằng bản thử; khi đó chỉ xem, không sửa, không chạy. Thông báo chỉ hiện một lần cho mỗi dự án trên máy này. **Đúng:** thông báo đếm cả các cảnh “từng nối video (nay chỉ gửi ảnh)” và **Xem** chọn được chúng; video đã tạo của các cảnh còn trong dự án vẫn xem được. Chưa làm phần này thì ghi Chưa thử.

24. **Thử cảnh dùng ảnh bình thường.** Cần cổng canvasapp.io.vn đã bật (chưa cần đăng nhập) hoặc đang chọn Phát triển (giả lập); nếu không, xem phần “Hộp xác nhận chi phí” ở đầu danh sách. Nối ảnh, điền prompt `@image` hợp lệ và kiểm tra hộp chạy, rồi Huỷ. Nếu dự án thử có video đã tạo xong: kéo video đó ra chỗ trống trên canvas → **Tạo cảnh tiếp theo từ video này**. **Đúng:** ảnh tham chiếu vẫn dùng được; bỏ `@video` không làm hỏng luồng ảnh. Cảnh mới nằm cạnh video, cùng ảnh tham chiếu và cấu hình của video đó, prompt trống; video không được gửi kèm làm tham chiếu. **Nếu lỗi:** ghi model, số ảnh và cảnh báo.

## An toàn credit khi mất phản hồi

**“Không rõ đã trừ chưa”** nghĩa là app chưa biết canvasapp đã nhận lượt gửi hay chưa. Nó không có nghĩa là miễn phí hay chắc chắn thất bại. App phải tìm lượt cũ trước; thiếu bằng chứng thì giữ cảnh báo, không tự gửi lại. **Tạo lại** là một take mới và có thể trả tiền thêm. Huỷ trong SanoVids cũng không bảo đảm canvasapp hoàn tiền.

25. **[DEV] Mất phản hồi sau khi đã tạo job.** Ghi số dư dev; Bảng phát triển → Gây lỗi → **Mất phản hồi sau khi tạo job (đã trừ tiền)**, chạy một cảnh. **Đúng:** app tìm lại job cũ, chỉ có một job cho lượt đó và chỉ trừ một lần credit dev. **Nếu lỗi:** ghi số dư trước/sau, mã take, số job và Copy nhật ký. Không gây lỗi này trên tài khoản thật.

26. **Nếu gặp cảnh báo không rõ lần gửi.** Đọc nguyên thông báo và mục Chi phí trong cửa sổ xem take. **Đúng:** app nói rõ sự chưa chắc chắn; nếu không kiểm tra được lần trước nữa thì từ chối gửi lại take đó. Nút **Tạo lại** phải được hiểu là lượt mới. **Nếu lỗi:** ghi lời cảnh báo, nút đang có, số dư và thời điểm; với credit thật, dừng và đối chiếu lịch sử credit / job trước, không bấm lặp để “thử xem”. Chưa gặp trường hợp này thì ghi Chưa thử.

27. **[Tài khoản thật, tuỳ chọn] Theo dõi một lượt bạn vốn định tạo.** Ghi số dư và giá xác nhận; chỉ gửi một lần, đợi hết trạng thái đang gửi rồi đóng và mở lại SanoVids. **Đúng:** app theo dõi đúng take cũ; không có lượt tạo thứ hai do mở lại. **Nếu lỗi:** ghi mã take/job, giờ gửi, số dư trước/sau và lịch sử credit. Dừng ngay nếu thấy job trùng hoặc bị trừ thêm. Không cắt mạng hay gây lỗi để thử trừ tiền hai lần.

## Tải video theo từng phần: tiến độ, huỷ, tải tiếp

Các bước gây ngắt hoặc huỷ dưới đây đều dùng **[DEV]**. “Tải tiếp” là tiếp tục nhận file của job đã có, khác với chạy lại cảnh để tạo video mới. Sau khi đóng hẳn app, không yêu cầu phần trăm tải phải được giữ nguyên.

28. **[DEV] Nhìn tiến độ tải.** Bật lỗi **Tải video chậm**, chạy một cảnh và chờ video tạo xong. **Đúng:** take chuyển sang **Đang tải về …%** khi biết dung lượng; app vẫn thao tác được, nhận đủ file mới báo xong. **Nếu lỗi:** ghi phần trăm đứng lại, thời gian chờ, trạng thái take và nhật ký.

29. **[DEV] Huỷ khi đang tải.** Bấm Huỷ ở take đã tạo xong trên giả lập nhưng còn tải; lần đầu từ chối huỷ, lần sau đồng ý. **Đúng:** app hỏi rõ video đã trừ credit dev; từ chối thì tiếp tục tải, đồng ý thì dừng trong SanoVids. Job vẫn còn ở giả lập, không được báo hoàn tiền. **Nếu lỗi:** chụp câu hỏi, trạng thái sau mỗi lựa chọn và số dư dev.

30. **[DEV] Tải tiếp sau ngắt.** Bật **Cho tải tiếp video (HTTP Range)** ở Trạng thái; gây **Mất mạng giữa chừng khi tải video**, chạy một cảnh. **Đúng:** video cuối cùng về đủ, không tạo job mới hay trừ thêm; Nhật ký có phản hồi **206** khi tải tiếp. **Nếu lỗi:** ghi tiến độ trước/sau, mã job và nhật ký. Không cần tự tắt mạng máy.

31. **[DEV] Máy chủ không cho tải tiếp.** Tắt công tắc Range rồi lặp lỗi ngắt một lần. **Đúng:** app có thể tải lại file từ đầu; phần trăm có thể quay về thấp hơn. Không tạo lại video, không trừ thêm credit dev và không coi file thiếu là hoàn tất. Mở video, tua gần cuối để kiểm tra. **Nếu lỗi:** ghi video bị cụt, tải lặp hoặc số dư thay đổi.

## Nhập job đã tạo ở trang canvasapp

32. **[DEV] Tạo mẫu và nhập.** Bảng phát triển → Job & đơn nạp → **Tạo job như trên trang canvasapp**, chọn node của cảnh thử. Ghi số dư sau khi tạo; Hàng đợi → **Nhập job** → chọn và nhập. **Đúng:** job vào đúng cảnh, take có nhãn **nhập**, video tự về khi xong; thao tác nhập không trừ thêm credit. **Nếu lỗi:** ghi job, cảnh trước/sau, số dư và ảnh hộp Nhập job.

33. **Quét lại và đọc thông tin.** Mở Nhập job lần nữa, quét lại; xem take vừa nhập. **Đúng:** không nhập trùng; thông tin thiếu phải ghi chưa rõ hoặc có dấu **?**, thông tin suy ra có **≈**, không biến thành số chắc chắn. **Nếu lỗi:** chụp trường sai và ghi thông tin thật bạn biết từ job. Nếu có sẵn job thật đủ điều kiện trong “SanoVids bridge”, có thể thử nhập tương tự; không cần tạo job thật riêng cho bài này.

34. **[DEV] Thử Chạy lại take nhập.** Bấm Chạy lại rồi đọc hộp xác nhận và Huỷ. **Đúng:** đây là tạo take mới, có chi phí mới; không được mô tả là chỉ tải lại file cũ. **Nếu lỗi:** chụp hộp xác nhận và kiểm tra có job nào được tạo trước khi đồng ý không.

## Xem video trên thẻ và trong cửa sổ

35. **Hình sạch và thanh thời gian.** Phát video ngang, dọc, vuông nếu có; đổi kích thước thẻ. **Đúng:** thấy trọn khung hình; thanh thời gian nằm dưới hình; tên, mã take, DEV và ★ không che hình. Thông số thời lượng, độ phân giải, tỉ lệ vẫn đọc được. **Nếu lỗi:** ghi tỉ lệ video, kích thước thẻ, mức zoom và chụp phần bị che/cắt.

36. **Phóng to.** Bấm **Phóng to** ở thanh phát, tua tới giữa rồi Esc. **Đúng:** thoát toàn màn hình về thẻ, không phát lại từ đầu. Khi đang toàn màn hình, Delete không xoá thẻ sau lưng. **Nếu lỗi:** ghi thời điểm phát trước/sau và phím đã bấm. Chỉ dùng video thử.

37. **Đổi tên.** Bấm đúp tên phía trên trái thẻ, nhập tên tiếng Việt và Enter; thử đổi lần nữa rồi Esc. Tải video mẫu vào thư mục thử. **Đúng:** Enter lưu, Esc bỏ lần sửa đó; tên không che thông số, file lưu dùng tên đã chốt. **Nếu lỗi:** ghi tên nhập, tên trên thẻ và tên file thực tế.

38. **Phím khi đang xem.** Trong cửa sổ xem take, Phát liền và thẻ đã Phóng to: bấm Space, K, J/L, ←/→, Shift+←/→, Home/End. **Đúng:** Space phát/dừng; K dừng; J/L lùi/tới, bấm thêm tăng 2× rồi 4×; mũi tên ngang đi từng khung, Shift đi 5 khung; Home về đầu, End dừng ở khung cuối. Bấm vào hình trước nếu con trỏ đang ở thanh trượt. **Nếu lỗi:** ghi đang xem ở đâu, phím, bộ gõ và tốc độ hiển thị.

39. **Chuyển video và thoát toàn màn hình.** Trong cửa sổ xem take dùng ↑/↓ đổi take; trong Phát liền dùng ↑/↓ đổi cảnh. Ở thẻ Phóng to, ↑/↓ đổi âm lượng. Thử Esc khi cửa sổ xem đang toàn màn hình. **Đúng:** lần Esc đầu chỉ thoát toàn màn hình, cửa sổ xem còn mở; các phím không làm mất chữ khi đang đổi tên. **Nếu lỗi:** ghi nơi con trỏ đang đứng và cửa sổ nào bị đóng.

## Thư viện: chọn nhiều và xoá một lần bấm

40. **Xoá ảnh chưa dùng.** Bấm chọn một thẻ ghi chưa dùng trong Thư viện rồi Delete một lần; Ctrl+Z. **Đúng:** xoá ngay, có Hoàn tác và ảnh trở lại. Delete lần nữa khi chưa chọn thẻ khác không tự xoá thẻ kế tiếp. **Nếu lỗi:** ghi số thẻ trước/sau và vùng bạn vừa bấm.

41. **Xoá ảnh đang dùng.** (a) Chọn ảnh đang được nhắc trong prompt (`@image_N`), hoặc đang là khung đầu/cuối; Delete, thử Huỷ rồi thử đồng ý. (b) Chọn ảnh chỉ được nối vào cảnh mà prompt không nhắc tới; Delete. **Đúng:** (a) app hỏi tác động trước; Huỷ giữ nguyên; đồng ý làm chỗ `@image` thành chữ đỏ, cảnh thiếu ảnh bị chặn. (b) xoá ngay, **không hỏi**; thông báo ghi số cảnh đang dùng và có Hoàn tác. Cảnh đó có thể thành thiếu ảnh tham chiếu: kiểm tra rồi Ctrl+Z. Cả hai trường hợp Ctrl+Z đều khôi phục được. **Nếu lỗi:** ghi ảnh, cảnh bị ảnh hưởng và nội dung câu hỏi hoặc thông báo.

42. **Chọn nhiều và lọc.** Ctrl+bấm chọn rời, Shift+bấm chọn một dải; thử Ctrl+A trong Thư viện. Lọc để một phần lựa chọn bị ẩn rồi Delete trên ảnh thử. **Đúng:** chỉ xoá các thẻ đang chọn và đang hiện; thẻ bị ẩn bởi bộ lọc không bị xoá theo; số lượng được báo rõ. **Nếu lỗi:** ghi bộ lọc, số chọn/ẩn và tên ảnh mất.

43. **Không xoá nhầm canvas.** Chọn một cảnh trên canvas, rồi bấm thẻ Thư viện và Delete; sau đó thả một ảnh từ Thư viện ra canvas và Delete. Thử gõ tiếng Việt, Backspace trong ô tìm kiếm. **Đúng:** Delete tác động vào vùng vừa dùng; trên canvas chỉ ẩn thẻ ảnh, không xoá khỏi Thư viện. Backspace khi gõ chỉ sửa chữ; ngoài ô gõ trên Windows phải nhắc dùng Delete. **Nếu lỗi:** ghi thứ tự bấm/thả và đối tượng bị xoá nhầm.

## Canvas, Phát liền và thứ tự cảnh

44. **Hai màn cũ đã ẩn.** Tìm Bảng cảnh / Storyboard trên thanh trên cùng; ngoài ô gõ, thử các phím 1/2/3 cũ. **Đúng:** không mở hai màn này; dự án vẫn ở Canvas. **Nếu lỗi:** chụp nút còn thấy hoặc màn được mở.

45. **Phát liền.** Bấm **Phát liền** giữa thanh trên cùng với dự án có ba cảnh, trong đó một cảnh chưa có video; chọn ★ cho một take. **Đúng:** phát theo thứ tự cảnh; ưu tiên take ★, nếu chưa chọn thì dùng take hoàn tất mới nhất. Cảnh chưa có video được nhận diện rõ; tổng thời lượng không tự bịa thời lượng cho take nhập chưa rõ. **Nếu lỗi:** ghi thứ tự cảnh, take được dùng và con số tổng.

46. **Đổi thứ tự cảnh.** Chọn cảnh, dùng ▲/▼ ở mã cảnh trên bảng bên phải; bấm mã để nhập vị trí. Thử Alt+↑/↓ vài lần liền rồi Ctrl+Z. **Đúng:** mã cảnh, Phát liền và thứ tự tải .zip theo thứ tự mới; vị trí thẻ trên canvas không tự xáo. Một chuỗi dời nhanh cùng cảnh được hoàn tác cùng nhau. **Nếu lỗi:** ghi thứ tự trước/sau, số lần bấm và thứ tự video trong .zip.

## Chuột phải và ngắt nối nhanh (khi bản thử có tính năng này)

Menu Cắt / Sao chép / Dán trong ô nhập chữ đã có phần xử lý trong mã hiện tại. Menu cho thẻ, dây và nền canvas còn chờ ghép vào bản thử.

47. **Menu đúng nơi.** Chuột phải lần lượt vào cảnh, video, ảnh, Thư mục, dây, nền trống, thẻ Thư viện và nhóm đang chọn. **Đúng:** mỗi nơi chỉ hiện lệnh phù hợp; xoá/huỷ ghi rõ đối tượng, video cần xác nhận trước khi xoá. Không có video tham chiếu hay hai màn cũ. **Nếu lỗi:** chụp menu và ghi những thẻ đang chọn trước khi mở.

48. **Ngắt nối nhanh.** Chọn một hoặc vài cảnh, chuột phải ảnh đã nối vào chúng; chọn lệnh ngắt khỏi cảnh đang chọn, rồi Ctrl+Z. **Đúng:** chỉ ngắt các cặp được nêu; prompt giữ chữ đỏ `@image_?N(tên)`, một lần Hoàn tác nối lại. **Nếu lỗi:** ghi ảnh, các cảnh chọn, cảnh ngoài lựa chọn có bị ảnh hưởng không.

49. **Dây chồng và bàn phím.** Chuột phải nơi nhiều dây chồng, chọn đúng dây theo tên hai đầu; thử mũi tên, Enter, Esc trong menu. **Đúng:** xác định được dây muốn ngắt, Esc đóng menu; phím không chạy lệnh canvas phía sau. Trong ô prompt, chuột phải phải có lệnh sửa chữ; thử Sao chép/Dán. **Nếu lỗi:** ghi menu nào và dây hoặc chữ bị tác động sai.

## Phím kiểu Premiere và phím riêng (khi bản thử có tính năng này)

Phím trong trình xem ở bước 38–39 đã có. Bộ phím toàn canvas và màn tự đổi phím còn đang ghép; ở bản hiện tại, M trên canvas vẫn có thể là bản đồ nhỏ. Đọc bảng Phím tắt của chính bản đang thử.

50. **Bộ mặc định mới.** Ngoài ô gõ: thử Ctrl+N tạo cảnh trống, Ctrl+F tìm Thư viện, Ctrl+I thêm ảnh, `\` hoặc F vừa màn hình; chọn một take rồi M; Shift+M bật/tắt bản đồ. **Đúng:** lệnh đúng tên, M chọn ★, Shift+M điều khiển bản đồ. Ctrl+M tải video theo lựa chọn; Ctrl+L hoặc C nối, bấm lại khi tất cả đã nối thì ngắt; Ctrl+Shift+L chỉ ngắt. **Nếu lỗi:** ghi bộ phím đang chọn, vùng đang dùng và lựa chọn hiện tại.

51. **Phím phát trên canvas.** Chọn một video, chạm Space; giữ Space+kéo canvas; thử J/K/L. Bỏ chọn rồi chạm Space. **Đúng:** chạm phát/dừng video, giữ+kéo chỉ di chuyển canvas; không chọn gì thì mở Phát liền. **Nếu lỗi:** ghi có kéo chuột không, thời gian giữ Space và video nào phát.

52. **Tự đổi phím.** Cài đặt → Phím tắt: gán phím mới cho Vừa màn hình; thêm phím thứ hai; thử gán phím đã dùng cho lệnh khác. **Đúng:** tối đa hai tổ hợp mỗi lệnh; trùng thì hỏi thay thế / chọn lại / huỷ, không đổi âm thầm. Bảng trợ giúp và nhãn gợi ý hiện phím mới; đóng mở app vẫn nhớ. **Nếu lỗi:** ghi phím cũ/mới, lựa chọn trong hộp trùng và nơi nhãn chưa đổi.

53. **Đổi bộ phím và bộ gõ.** Chọn bộ **Bản 0.5**, quay về **Premiere**, thử đặt lại rồi Hoàn tác. Gõ một câu tiếng Việt trong prompt/tìm kiếm; thử Ctrl+S. **Đúng:** khôi phục được cấu hình trước; bộ 0.5 không làm sống lại Bảng cảnh/Storyboard. Phím khi gõ chỉ sửa/lưu chữ, không xoá cảnh; Enter/Esc/Ctrl+Enter trên thẻ vẫn theo bước 13–14. **Nếu lỗi:** ghi Unikey/EVKey hay bộ gõ khác, chế độ Telex/VNI và phím gây lỗi.

## Thanh công cụ gọn, kéo được (khi bản thử có tính năng này)

54. **Nút và chỗ hẹp.** Mở dự án, rê từng biểu tượng; thu nhỏ cửa sổ. **Đúng:** mặc định thanh ở dưới, chỉ biểu tượng, có tên và phím khi rê; nút không đủ chỗ vào menu thêm. Tạo cảnh, Thư mục, Nối, Chạy, Sắp xếp, vừa màn hình và các lựa chọn hiển thị tìm được. Chạy mở hộp chi phí khi cổng canvasapp.io.vn đã bật hoặc đang chọn Phát triển (giả lập); nếu không, thông báo “Chưa bật cổng canvasapp.io.vn…” có nút **Mở Cài đặt** là đúng. Huỷ không tạo job. **Nếu lỗi:** chụp thanh, độ rộng cửa sổ và nút bị thiếu.

55. **Kéo thanh và đổi cỡ cửa sổ.** Kéo tay nắm ra giữa rồi tới bốn cạnh; đóng mở khung bên và Hàng đợi; mở lại app. **Đúng:** bám cạnh trái/phải thì thanh dọc; thanh nằm trong vùng canvas, nhớ vị trí, không che chỗ đang gõ hay nút quan trọng. Esc lúc kéo trả về chỗ cũ. **Nếu lỗi:** ghi cạnh, kích thước cửa sổ và vị trí bị kẹt.

56. **Khay theo lựa chọn.** Chọn từ hai thẻ cảnh, một video, rồi dây nối; thử một lệnh phù hợp trong khay. Dùng Tab và mũi tên trên thanh. **Đúng:** khay đổi theo lựa chọn; xoá và ngắt dùng đúng cảnh báo/Hoàn tác; vòng chọn bàn phím thấy rõ. Bấm ngoài menu chỉ đóng menu, không cắt dây phía sau. **Nếu lỗi:** chụp lựa chọn, khay và thao tác lọt xuống canvas. Chưa yêu cầu trình tự sắp lại mọi nút hay thanh thu gọn thành viên nhỏ.

## Kiểu sắp xếp và tên preset (khi bản thử có tính năng này)

57. **Ba kiểu sắp xếp.** Mở mũi tên cạnh Sắp xếp; lần lượt thử **Theo hàng**, **Lưới**, **Dải ngang**, số cảnh mỗi hàng và khoảng cách. **Đúng:** xem trước chưa dời thẻ; bấm Sắp xếp mới áp dụng; video nằm cạnh cảnh. Nút chính lần sau dùng kiểu vừa chọn; lần đầu mặc định Theo hàng. **Nếu lỗi:** chụp lựa chọn, phần xem trước và chỗ thẻ đè nhau.

58. **Phạm vi và Hoàn tác.** Chọn vài cảnh rồi chỉ xếp các mục đang chọn; thử Lưới với **Chỉ take chọn**; Ctrl+Z một lần. **Đúng:** cảnh ngoài phạm vi giữ vị trí; nếu ẩn take khác thì app nói rõ đó là lựa chọn hiển thị cho các dự án trên máy, không phải xoá video. Hoàn tác trả cả vị trí và cách hiện take; Thư mục chỉ phải dời nếu bị đè. **Nếu lỗi:** ghi cảnh ngoài nhóm bị dời hoặc video tưởng đã mất; thử hiện Tất cả.

59. **Tên bộ cấu hình.** Tạo dự án mới rồi mở bản sao dự án cũ có cả bộ mặc định và bộ tự sửa. **Đúng:** bộ mặc định có tên **Bản nháp**, **Bản chốt**, **H3 từ ảnh**; thông số không đổi. Chỉ bộ còn nguyên tên và thông số gốc được đổi tên; bộ người dùng tự đặt/sửa giữ nguyên. Lưu mở lại không đổi tiếp. **Nếu lỗi:** ghi tên, thông số trước/sau và bộ nào bạn đã sửa.

## Giao diện và ba nền tối (khi bản thử có tính năng này)

60. **Ba màu nền.** Cài đặt → Cơ bản → Giao diện: chọn Tối, rồi **Màu nền: Than / Đen sâu / Xám xanh**. **Đúng:** mặc định Than; đổi nền ngay, chữ đỏ, dây, lựa chọn và nút vẫn dễ đọc. **Nếu lỗi:** ghi nền nào, chỗ khó đọc và ảnh chụp.

61. **Nhớ nền và chế độ sáng.** Chọn Xám xanh, đóng mở app; đổi sang Sáng rồi về Tối. Xuất cài đặt, đặt lại mặc định rồi nhập lại. **Đúng:** nhớ màu nền; chế độ Sáng dùng nền sáng riêng, không bị nhuộm theo nền tối; nhập cài đặt trả lựa chọn đã xuất. **Nếu lỗi:** ghi màu trước/sau và có chớp nền sai khi mở app không.

62. **Đọc và thao tác bằng bàn phím.** Ở Sáng và ba nền Tối, mở menu, hộp thoại, chữ đỏ chờ ảnh và video; dùng Tab; thử mức hiệu ứng Giảm/Tắt. **Đúng:** thấy vị trí đang chọn, đọc rõ chữ, hình video không bị lớp giao diện che; app vẫn dùng được khi giảm hiệu ứng. **Nếu lỗi:** ghi màn hình, nền và thành phần khó thấy.

## Lưu file và dự án cũ: kiểm tra thêm từ các thay đổi 0.6.0

63. **Ngắt dây lưu vào Thư mục.** Dùng video trong dự án thử và một thư mục thử trống. Trước tiên mở Cài đặt → Tải video, **chưa đổi gì**: ghi trạng thái công tắc **Bỏ nối video khỏi Thư mục thì chuyển file vào Thùng rác** và nhớ lựa chọn bạn đang dùng. (a) Nối video → Thư mục thử, đợi lưu xong rồi cắt dây (mặc định, bấm một lần vào dây là cắt); đọc thông báo và thử Hoàn tác. (b) Tắt công tắc, nối lại, đợi lưu xong rồi cắt dây lần nữa. Cuối cùng đặt công tắc về lựa chọn bạn muốn dùng. **Đúng:** công tắc **bật sẵn**, kể cả khi cập nhật từ 0.5.0. (a) file video và file .txt prompt đi kèm do chính dây đó lưu được chuyển vào Thùng rác; lần đầu trên máy, thông báo nhắc “Tắt ở Cài đặt → Tải video.”; Hoàn tác khôi phục liên kết và ghi một bản mới vào thư mục, bản cũ vẫn trong Thùng rác. Không ảnh hưởng file khác; nếu không xử lý được phải báo rõ. (b) file đã lưu vẫn còn trong thư mục. **Nếu lỗi:** ghi công tắc lúc đầu, tên file, đường dẫn thư mục thử, trạng thái Thùng rác và thông báo.

64. **Dữ liệu của bản mới hơn.** Chỉ thử nếu được cung cấp file dự án mẫu có model/thông số mà bản đang dùng chưa biết; mở, lưu bản sao rồi mở lại. **Đúng:** dữ liệu lạ còn được giữ, cảnh liên quan bị chặn chạy và có lý do; không âm thầm đổi sang model khác. **Nếu lỗi:** ghi tên mẫu và nhãn cảnh báo. Không tự sửa file phim thật để tạo tình huống này.

## Tự cập nhật từ 0.6.0 lên bản kế tiếp

Chỉ làm khi người làm app đã cung cấp bản kế tiếp hợp lệ trên kênh thử/phát hành. Không có bản mới thì ghi **Chưa thử**, không sửa số phiên bản, file cập nhật hay chứng chỉ để ép thử. Tự cập nhật đã có từ 0.5.0; phần này kiểm tra nó còn hoạt động với các thay đổi 0.6.0.

65. **Setup: kiểm tra và tải.** Cài đặt → Cập nhật → **Kiểm tra ngay**; xem Có gì mới và tiến độ tải. **Đúng:** báo đúng bản mới; bật Tự động tải bản cập nhật thì tải nền, tắt thì đợi bạn yêu cầu. Dự án vẫn sửa được trong lúc tải. **Nếu lỗi:** ghi phiên bản đang dùng/bản được báo, công tắc và thông báo nguyên văn.

66. **Setup: cài rồi mở lại.** Trước khi cài: tải về các video cần giữ và Xuất dự án (file xuất chỉ dự phòng cảnh, prompt, ảnh; không có video). Gõ thêm câu thử, chọn **Khởi động lại để cập nhật**. Nếu có lượt đang làm, chỉ thử **Cập nhật khi xong** với DEV: thử Huỷ đếm ngược rồi đặt lại. **Đúng:** app đợi công việc, lưu cả chữ đang gõ, mở lại đúng bản mới; dự án, video đã tạo và cài đặt vẫn còn sau khi cập nhật. Chọn Để sau khi bản đã tải sẵn thì bản cài có thể cập nhật lúc tắt app. **Nếu lỗi:** ghi nút đã chọn, phiên bản sau mở lại, phần dữ liệu thiếu và thông báo lỗi.

67. **Portable: chỉ báo bản mới.** Làm Kiểm tra ngay khi bản mới có sẵn. **Đúng:** nút **Tải bản mới** dẫn tới trang tải; Portable không tự cài hay tự thay file đang chạy. Tải/thay bản bằng tay khi bạn quyết định. Nếu gặp lỗi xác minh chữ ký ở bất kỳ bản nào, dừng và ghi nguyên thông báo; không tự bỏ kiểm tra để cài. **Nếu lỗi:** ghi loại bản, phiên bản và hành động app đã thực hiện.

## Mac thử nghiệm — mục riêng (khi bản thử có tính năng này)

Chỉ người có **Mac Apple Silicon** và bản thử do tác giả cung cấp mới làm nhóm này. Bản Mac cập nhật thủ công, chưa có chữ ký Developer ID và xác nhận của Apple như một bản phát hành Mac hoàn chỉnh. Không đánh dấu nhóm này đạt bằng kết quả Windows.

68. **Mở và nhận diện.** Ghi chip máy, phiên bản macOS (gồm macOS 27 nếu đó là máy thử), tên file nhận được; đưa app vào Applications theo hướng dẫn của bản thử rồi mở Giới thiệu. **Đúng:** nhận diện bản Mac thử nghiệm, chữ ký thử nghiệm; khi chạy từ nơi chưa phù hợp có lời nhắc, không tự dời app. **Nếu lỗi:** chụp thông báo macOS/app và ghi đang mở từ đâu; không tắt bảo vệ hệ thống để ép chạy.

69. **Phím, chữ và file.** Thử ⌘S, ⌘A, ⌘Z, ⌫ trong Thư viện, ⌃+bấm để mở menu, tải video bằng ⌘E ở nơi có lệnh đó; lưu tên tiếng Việt và Mở trong Finder. **Đúng:** chữ hướng dẫn hợp Mac, ⌘M vẫn thu nhỏ cửa sổ, tên file không hỏng dấu; phím trong ô gõ không xoá thẻ. **Nếu lỗi:** ghi phím, vùng đang dùng, tên file và bộ gõ.

70. **Phiên đăng nhập và cập nhật.** Trong Applications, thử giữ đăng nhập rồi Đăng xuất như bước 5–7; thử Kiểm tra ngay khi có bản kế tiếp. **Đúng:** hướng dẫn giữ phiên nói đúng về Keychain trên Mac; đăng xuất không tự phục hồi. Cập nhật dẫn tới tải/cài bằng tay; nếu bản mới nhất chỉ có Windows, phải báo chưa có bản Mac mới hơn, không kết luận đang mới nhất. **Nếu lỗi:** ghi thông báo và phiên bản Mac/Windows đang được báo.

## Gửi kết quả

Gửi bảng Setup/Portable cùng các dòng lỗi; Mac ghi riêng. Mỗi lỗi cần số bước, phiên bản thực tế, thao tác cuối, điều mong đợi và điều đã xảy ra. Lỗi DEV kèm nhật ký giả lập; lỗi credit thật kèm số dư trước/sau và thời điểm, che thông tin riêng tư.

**Dừng tạo video thật** nếu thấy job trùng, credit bị trừ ngoài lượt đã xác nhận hoặc ảnh tham chiếu trỏ sai nhân vật. Giữ lại bằng chứng, không chạy thêm để thử sửa. Các mục Chưa có / Chưa thử phải được thử lại trên đúng bản có tính năng trước khi kết luận bản đó dùng được cho phim thật.
