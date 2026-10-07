# Bản nháp ghi chú 0.6.0

Chưa phải thông báo đã phát hành. Đối chiếu mã đến `0d7f3cb` ngày 07/10/2026 và kế hoạch đợt 3. Các mục ghi **(khi bản thử có tính năng này)** đang chờ ghép hoặc thử trên bản đóng gói; chỉ bỏ nhãn sau khi đã kiểm tra. Ngày phát hành bên dưới chưa chốt. Bước phát hành sẽ đưa phần đã xác nhận vào CHANGELOG.md.

---

## [0.6.0] — Chưa chốt ngày — Sửa cảnh ngay trên canvas, xem video rõ hơn, giữ đúng ảnh tham chiếu

✨ **Thẻ cảnh là nơi sửa prompt và cấu hình**
- Bấm vào prompt trên thẻ để gõ ngay. Bấm dòng thông số để đổi model, thời lượng, độ phân giải, tỉ lệ và preset. Không cần qua lại bảng bên phải cho mỗi lần sửa.
- Enter khi chọn một cảnh đưa con trỏ vào prompt; Enter trong ô gõ xuống dòng, Esc rời ô và giữ chữ. Ctrl+Enter mở xác nhận tạo video cho đúng cảnh đang sửa.
- Nút **Tạo video · … credit** nói rõ chi phí. Cảnh chưa đủ điều kiện hiện lý do ngay trên thẻ, như **Chưa chạy · còn chữ đỏ**.
- Giữ chữ đang gõ khi đổi cảnh, lưu hoặc đóng app. Prompt trên thẻ và bảng bên phải dùng cùng nội dung.

✨ **Cắt ảnh tham chiếu không làm mất chỗ nhắc trong prompt**
- Ví dụ cắt ảnh Lumi thì `@image_2` thành chữ đỏ **`@image_?2(Lumi)`**. Bạn vẫn biết câu đó cần ảnh nào; app **chặn tạo video** cho tới khi điền đủ hoặc chủ động sửa đoạn chữ.
- Dải **Chữ đỏ chờ ảnh** giúp gắn ảnh đã nối vào đúng chỗ; có thể kéo ảnh vào chỗ chờ trên thẻ. Không tự lấy ảnh khác vừa dồn lên cùng số để thay nhân vật.
- Muốn bỏ tham chiếu có chủ ý thì chọn **Đổi thành chữ “Lumi”**. Hoàn tác trả lại thay đổi. Xoá riêng dấu `?` vẫn không cho chạy nếu tên đi kèm không khớp ảnh.

✨ **Xem video trọn hình**
- Thanh thời gian nằm **dưới hình**. Mã take, tên, DEV và ★ nằm ngoài hình; video dọc, vuông và ngang được hiển thị trọn khung.
- Nút **Phóng to** mở toàn màn hình, Esc trở về thẻ mà không phát lại từ đầu. Tên file và ô đổi tên nằm phía trên bên trái, không che thông số.
- Cửa sổ xem take, Phát liền và thẻ Phóng to dùng chung phím: Space phát/dừng, K dừng, J/L lùi/tới và tăng tốc, ←/→ từng khung hình, Shift+←/→ năm khung, Home/End về đầu/khung cuối.
- ↑/↓ đổi take trong cửa sổ xem, đổi cảnh trong Phát liền; trên thẻ Phóng to thì chỉnh âm lượng. Esc khi toàn màn hình chỉ thoát toàn màn hình trước.

✨ **Giữ đăng nhập canvasapp sau khi mở lại**
- Công tắc **Giữ đăng nhập canvasapp trên máy này** trong Cài đặt → Cổng canvasapp.io.vn. Mặc định **bật ở Setup**, **tắt ở Portable** nếu chưa tự chọn trước đó.
- Phiên được lưu có mã hoá, tối đa **30 ngày** hoặc đến khi canvasapp kết thúc phiên. Máy không giữ phiên an toàn được sẽ báo rõ và yêu cầu đăng nhập lại.
- Tắt công tắc vẫn dùng được phiên hiện tại; lần mở sau phải đăng nhập lại. **Đăng xuất** xoá phiên đã giữ ngay.

🛠️ **Thận trọng hơn khi chưa rõ canvasapp đã nhận lượt tạo video**
- Sau khi mất phản hồi, SanoVids tìm job cũ trước. Không thấy trong danh sách chưa đủ để kết luận chưa bị trừ credit; thiếu bằng chứng thì app từ chối gửi lại take đó.
- Cảnh báo **không rõ đã bị trừ chưa** giữ nguyên ý nghĩa chưa xác định. **Tạo lại** là take mới, có thể trừ thêm credit; hãy kiểm tra job và lịch sử credit trước.
- Cải thiện việc nhận đúng job khi nhiều lượt gửi gần nhau, mở lại app, đăng xuất rồi đăng nhập hoặc đổi tài khoản. Không dùng job đã nhập từ trang để gán nhầm cho một lượt đang chờ phản hồi.

✨ **Tải video có tiến độ, huỷ và tải tiếp**
- Video kết quả được nhận theo từng phần. Take hiện **Đang tải về …%** khi biết dung lượng; tải đủ file mới hoàn tất.
- Mất kết nối giữa chừng có thể tải tiếp nếu máy chủ hỗ trợ; nếu không, app có thể tải lại file từ đầu. Đây là tải file của job cũ, không phải tạo một video mới.
- Huỷ khi video đã tạo xong nhưng chưa tải hết sẽ hỏi trước và nói rõ video đã trừ credit. Huỷ trong SanoVids không bảo đảm được hoàn credit ở canvasapp; chạy lại cảnh là một lượt mới.

✨ **Nhập job tạo trên trang canvasapp**
- **Hàng đợi → Nhập job** tìm các job đủ điều kiện của dự án trên phiên “SanoVids bridge”, đưa về đúng cảnh dưới dạng take có nhãn **nhập** và tải video khi xong.
- **Nhập không trừ thêm credit**; chi phí đã thuộc lần tạo job trên trang. Quét lại không nhập trùng.
- Thông tin suy ra có dấu **≈**, thông tin thiếu được ghi chưa rõ. **Chạy lại** take nhập vẫn là một lượt tạo mới có xác nhận chi phí.

🛠️ **Thư viện: chọn nhiều, xoá nhanh**
- Bấm chọn thẻ rồi **Delete** để xoá; Ctrl+bấm chọn rời, Shift+bấm chọn dải, Ctrl+A chọn các thẻ đang hiện trong Thư viện. Có nút xoá cho nhóm đã chọn.
- Ảnh chưa dùng được xoá ngay và có Hoàn tác. Nếu xoá làm cảnh thiếu ảnh hoặc để lại chữ đỏ, app hỏi tác động trước.
- Đang lọc thì không xoá kèm thẻ bị ẩn. Sau khi xoá, không tự chọn thẻ kế tiếp để một lần Delete nữa xoá nhầm.
- Delete theo vùng bạn vừa dùng. Trên canvas, xoá thẻ ảnh chỉ ẩn thẻ; trong Thư viện mới xoá mục khỏi thư viện. Backspace trên Windows không dùng để xoá thẻ, tránh xung đột bộ gõ tiếng Việt.

🛠️ **Tập trung vào Canvas, Phát liền dễ tìm hơn**
- Ẩn **Bảng cảnh** và **Storyboard**, bỏ các phím chuyển sang hai màn này. **Phát liền** chuyển ra giữa thanh trên cùng.
- Đổi thứ tự cảnh bằng ▲/▼, nhập vị trí ở mã cảnh trên bảng bên phải hoặc Alt+↑/↓. Mã cảnh, Phát liền và .zip đi theo thứ tự mới; thẻ trên canvas giữ vị trí.
- Dời cùng một cảnh nhiều lần nhanh liên tiếp được gom thành một lần Hoàn tác. Phát liền không tính chắc chắn thời lượng của take nhập khi chưa có đủ thông tin.

🛠️ **Bỏ video tham chiếu**
- Không còn nối video vào cảnh để làm `@video`. Ảnh tham chiếu và khung đầu/cuối theo model vẫn dùng được.
- Dự án cũ còn chữ `@video` sẽ hiện đỏ và chặn chạy cảnh đó cho tới khi sửa prompt. Video kết quả của các cảnh còn trong dự án vẫn dùng để xem, chọn take và lưu.

🛠️ **Chế độ Phát triển được khoá trong bản phát hành**
- Người dùng thường không còn thấy Bảng phát triển hay lựa chọn giả lập cho take mới. Cổng canvasapp thật vẫn cần tự bật và xác nhận chi phí khi tạo video.
- Chủ ứng dụng mở hộp mã bằng **Cài đặt → Giới thiệu → bấm phiên bản 5 lần trong 3 giây**. Lần đầu dùng mã **SV1-…** cho đúng máy; sau khi liên kết có thể dùng mã 6 số từ app xác thực. Mã SV1 chỉ dùng một lần; chưa có nút tự gửi mã Gmail.
- Mở khoá không tự đổi nhà cung cấp. Muốn thử miễn phí phải chọn Phát triển (giả lập), kiểm tra chữ **DEV / credit dev** trước khi chạy. Take DEV cũ giữ nhãn của nó.
- Chủ ứng dụng có **Test giới hạn** trong Bảng phát triển để thử các tình huống trên dự án tạm bằng giả lập; không phải bài gây lỗi bằng credit thật.

✨ **Menu chuột phải và ngắt nối nhanh (khi bản thử có tính năng này)**
- Menu riêng cho cảnh, video, ảnh, Thư mục, dây, nền canvas, nhóm chọn và thẻ Thư viện; chỉ các lệnh phù hợp với chỗ vừa bấm.
- Chọn cảnh rồi chuột phải ảnh để ngắt khỏi những cảnh đang chọn, dễ dùng khi nhiều dây chồng nhau. Prompt vẫn giữ chữ đỏ chờ ảnh, có Hoàn tác.
- Xoá và huỷ dùng cùng các câu hỏi bảo vệ như nút/phím thường. Ô nhập chữ có menu Cắt / Sao chép / Dán.

✨ **Phím kiểu Premiere và tự đổi phím (khi bản thử có tính năng này)**
- Thêm các phím quen thuộc: Ctrl+N cảnh trống, Ctrl+F tìm Thư viện, Ctrl+I thêm ảnh, Ctrl+M tải video, M chọn ★; bản đồ nhỏ chuyển sang **Shift+M**. Ctrl+L hoặc C nối/ngắt, Ctrl+Shift+L chỉ ngắt.
- Phím cũ phù hợp vẫn làm phím phụ; Cài đặt → Phím tắt có bộ **Premiere** và **Bản 0.5**, không mở lại hai màn đã ẩn.
- Tự gán tối đa hai tổ hợp cho một lệnh, kiểm tra trùng trước khi thay. Nhớ theo máy, giữ phím đã tự chọn, có đặt lại và Hoàn tác; bảng trợ giúp và nhãn nút hiển thị phím thực tế.
- Trên canvas, chạm Space phát/dừng video đang chọn; giữ Space+kéo vẫn di chuyển canvas. Không chọn gì thì chạm Space mở Phát liền.

✨ **Thanh công cụ canvas gọn và kéo được (khi bản thử có tính năng này)**
- Mặc định thanh ở dưới với các biểu tượng và tên/phím khi rê chuột. Nút thiếu chỗ nằm trong menu thêm.
- Kéo tay nắm để đặt tự do trong canvas hoặc bám bốn cạnh; thanh đứng dọc ở trái/phải, nhớ vị trí trên máy và giữ trong cửa sổ khi đổi cỡ.
- Khay lệnh đổi theo nhóm cảnh, video hoặc dây đang chọn. Các lệnh tạo video vẫn mở xác nhận chi phí, xoá/ngắt vẫn dùng quy tắc Hoàn tác và cảnh báo chung.

✨ **Sắp xếp nhiều kiểu, tên preset dễ hiểu hơn (khi bản thử có tính năng này)**
- **Theo hàng**, **Lưới**, **Dải ngang**, có xem trước, số cảnh mỗi hàng, khoảng cách và phạm vi đang chọn. Nút chính dùng kiểu lần trước, mũi tên mở tuỳ chọn; mặc định Theo hàng.
- Một lần Hoàn tác trả vị trí và cách hiện take nếu lần xếp đã đổi nó. Chọn **Chỉ take chọn** chỉ ẩn các take còn lại, không xoá chúng; lựa chọn hiển thị này áp dụng cho các dự án trên máy.
- Bộ mặc định đổi **Nháp → Bản nháp**, **Final → Bản chốt**, **H3 nháp → H3 từ ảnh**. Giữ nguyên thông số. Bộ người dùng đã đổi tên hoặc sửa thông số không bị đổi theo.

✨ **Giao diện mới và ba nền tối (khi bản thử có tính năng này)**
- Kiểu giao diện và biểu tượng mới theo mẫu D đã chọn. Cài đặt → Giao diện có **Màu nền: Than / Đen sâu / Xám xanh**, mặc định **Than**.
- Màu nền chỉ áp dụng khi dùng giao diện Tối; giao diện Sáng có nền riêng. App nhớ lựa chọn, đưa vào xuất/nhập và khôi phục cài đặt.

🛠️ **Lưu file, mở dự án và thao tác dự án lớn**
- Khi bật **Bỏ nối video khỏi Thư mục thì chuyển file vào Thùng rác**, cắt dây lưu sẽ chuyển file do app lưu vào **Thùng rác**. Hoàn tác nối lại và ghi một bản mới; bản cũ vẫn trong Thùng rác. Hãy thử với thư mục mẫu trước.
- Nhắc rõ khi chạy Portable hoặc bản sao trong thư mục tạm. Mở dự án có model/thông số của bản mới hơn thì giữ dữ liệu chưa hiểu và chặn chạy phần liên quan, tránh âm thầm thay cấu hình.
- Giảm việc tính lại khi gõ prompt và hiển thị danh sách dài. Sửa lỗi lưu/mở lại dự án sau khi xoá Thư mục cuối cùng. Chưa coi các thay đổi này là cam kết tốc độ trên mọi máy.

⚠️ **Bản Mac thử nghiệm (khi bản thử có tính năng này)**
- Dành cho **Apple Silicon**, cần thử trên máy Mac thật. Chưa có chữ ký Developer ID và xác nhận của Apple; không coi kiểm tra Windows là kết quả của bản Mac.
- Dùng ký hiệu phím và tên thao tác của Mac: ⌘, Finder, Keychain. Phím tải video là **⌘E** để ⌘M vẫn thu nhỏ cửa sổ.
- Nên đặt app trong Applications. Bản Mac **chỉ báo và mở trang tải bản mới, cập nhật bằng tay**. Nếu lần phát hành mới chỉ có Windows, app phải nói chưa có bản Mac mới hơn.

⚠️ **Trước khi dùng cho phim thật**
- Làm [danh sách kiểm tra 0.6.0](TEST-0.6.0.md) riêng cho Setup và Portable. Các phần chưa có trong bản thử phải được thử lại sau khi ghép, chưa được coi là đã hoàn tất.
- Xuất bản sao dự án trước khi thử bản mới. Chữ đỏ chờ ảnh và `@video` cũ có thể làm cảnh chưa chạy được; hãy kiểm tra tham chiếu trước khi xác nhận chi phí.
- Tự cập nhật đã có từ 0.5.0: **Setup** tải/cài bản kế tiếp, **Portable** chỉ báo để tải và thay bản bằng tay. Cần có bản kế tiếp hợp lệ mới kiểm tra được trọn luồng cập nhật từ 0.6.0.
- Không cố gây lỗi với credit thật. Nếu không rõ đã bị trừ hay có job trùng, dừng tạo video và kiểm tra lịch sử; không hứa mọi trường hợp huỷ/lỗi đều được hoàn tiền.
