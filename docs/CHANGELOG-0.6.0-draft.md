# Bản nháp ghi chú 0.6.0

Chưa phải thông báo đã phát hành. Đối chiếu mã đến `0d7f3cb` ngày 07/10/2026 và kế hoạch đợt 3. Các mục ghi **(khi bản thử có tính năng này)** đang chờ ghép hoặc thử trên bản đóng gói; chỉ bỏ nhãn sau khi đã kiểm tra. Ngày phát hành bên dưới chưa chốt. Bước phát hành sẽ đưa phần đã xác nhận vào CHANGELOG.md.

Ghi chú cho bước phát hành (phần này không đưa vào CHANGELOG.md):
- Mọi thứ từ dòng `## [0.6.0]` trở xuống được `scripts/update-notes.mjs` chép vào latest.yml: đó là mục **Có gì mới** trong hộp cập nhật và trên trang tải công khai. Chỉ viết cho người dùng; không đưa đường dẫn tới danh sách kiểm tra hay lời dặn người thử vào đó.
- Hộp cập nhật chỉ giữ khoảng 7.900 ký tự đầu (`NOTES_CAP` trong `scripts/releaseLib.mjs`). Bản nháp này dài hơn: rút gọn khi đưa vào CHANGELOG.md và bỏ các mục chưa có trong bản phát hành.
- Chế độ Phát triển: theo câu 11a của kế hoạch ẩn chế độ Phát triển, ghi chú công khai chỉ có một câu. Cách mở khoá chỉ nằm trong tài liệu riêng của chủ ứng dụng (docs/DEV-UNLOCK.md và bước 9 của [danh sách kiểm tra 0.6.0](TEST-0.6.0.md)).
- Trước khi phát hành, làm [danh sách kiểm tra 0.6.0](TEST-0.6.0.md) riêng cho Setup và Portable. Các phần chưa có trong bản thử phải thử lại sau khi ghép. Muốn thử trọn luồng tự cập nhật từ 0.6.0 thì cần một bản kế tiếp hợp lệ.
- `scripts/__tests__/releaseNotes060.test.mjs` kiểm tra phần dành cho người dùng: của bản nháp này, rồi của mục [0.6.0] trong CHANGELOG.md sau khi gộp.

---

## [0.6.0] — Chưa chốt ngày — Sửa cảnh ngay trên canvas, xem video rõ hơn, giữ đúng ảnh tham chiếu

✨ **Thẻ cảnh là nơi sửa prompt và cấu hình**
- Bấm vào prompt trên thẻ để gõ ngay. Bấm dòng thông số để đổi model, thời lượng, độ phân giải, tỉ lệ và preset. Không cần qua lại bảng bên phải cho mỗi lần sửa.
- Enter khi chọn một cảnh đưa con trỏ vào prompt; Enter trong ô gõ xuống dòng, Esc rời ô và giữ chữ. Ctrl+Enter mở xác nhận tạo video cho đúng cảnh đang sửa.
- Nút **Tạo video · … credit** nói rõ chi phí. Cảnh chưa đủ điều kiện hiện lý do ngay trên thẻ, như **Chưa chạy · còn chữ đỏ**.
- Giữ chữ đang gõ khi đổi cảnh, lưu hoặc đóng app. Prompt trên thẻ và bảng bên phải dùng cùng nội dung.
- Lựa chọn model, chế độ, thời lượng, độ phân giải, tỉ lệ mà canvasapp đang tắt hiện mờ kèm lý do và không chọn được. Cảnh đang dùng chúng chưa chạy được (bị bỏ qua khi chạy nhiều cảnh, không tốn credit); cấu hình đã lưu của cảnh không bị đổi. Chưa đọc được cấu hình từ canvasapp thì chỉ ghi “có thể bị từ chối”; bấm **Đọc lại** để cập nhật ngay.

✨ **Cắt ảnh tham chiếu không làm mất chỗ nhắc trong prompt**
- Ví dụ cắt ảnh Lumi thì `@image_2` thành chữ đỏ **`@image_?2(Lumi)`**. Bạn vẫn biết câu đó cần ảnh nào; app **chặn tạo video** cho tới khi điền đủ hoặc chủ động sửa đoạn chữ.
- Dải **Chữ đỏ chờ ảnh** giúp gắn ảnh đã nối vào đúng chỗ; có thể kéo ảnh vào chỗ chờ trên thẻ. Không tự lấy ảnh khác vừa dồn lên cùng số để thay nhân vật.
- Muốn bỏ tham chiếu có chủ ý thì chọn **Đổi thành chữ “Lumi”**. Hoàn tác trả lại thay đổi. Xoá riêng dấu `?` vẫn không cho chạy nếu tên đi kèm không khớp ảnh.
- Bấm vào chữ đỏ trong ô prompt để chọn **Gắn ảnh đã nối…**, **Đổi thành chữ** hoặc **Xoá chữ đỏ**. Nối ảnh từ Thư viện (nút nối hoặc kéo thẻ vào cảnh) cũng gợi ý **Gắn vào chỗ …**. App không bao giờ tự gắn theo tên. (khi bản thử có tính năng này)
- Thay ảnh ngay: kéo đầu dây phía ảnh sang một ảnh khác trên canvas. Cảnh giữ đúng số `@image_N`, prompt không đổi chữ nào; nếu ảnh mới có ít tấm hơn thì chỗ thiếu thành chữ đỏ. Thả ra chỗ không hợp lệ thì không có gì thay đổi. Có Hoàn tác. (khi bản thử có tính năng này)

✨ **Xem video trọn hình**
- Thanh thời gian nằm **dưới hình**. Mã take, tên, DEV và ★ nằm ngoài hình; video dọc, vuông và ngang được hiển thị trọn khung.
- Nút **Phóng to** mở toàn màn hình, Esc trở về thẻ mà không phát lại từ đầu. Tên file và ô đổi tên nằm phía trên bên trái, không che thông số.
- Cửa sổ xem take, Phát liền và thẻ Phóng to dùng chung phím: Space phát/dừng, K dừng, J/L lùi/tới và tăng tốc, ←/→ từng khung hình, Shift+←/→ năm khung, Home/End về đầu/khung cuối.
- ↑/↓ đổi take trong cửa sổ xem, đổi cảnh trong Phát liền; trên thẻ Phóng to thì chỉnh âm lượng. Esc khi toàn màn hình chỉ thoát toàn màn hình trước.

✨ **Giữ đăng nhập canvasapp sau khi mở lại**
- Công tắc **Giữ đăng nhập canvasapp trên máy này** trong Cài đặt → Cổng canvasapp.io.vn. Mặc định **bật ở Setup**, **tắt ở Portable** nếu chưa tự chọn trước đó.
- Setup và Portable trên cùng tài khoản Windows dùng chung lựa chọn này. Nếu dùng cả hai bản, hãy tự bật hoặc tắt công tắc một lần để hai bản cùng theo lựa chọn của bạn.
- Phiên được lưu có mã hoá, tối đa **30 ngày** hoặc đến khi canvasapp kết thúc phiên. Máy không giữ phiên an toàn được sẽ báo rõ và yêu cầu đăng nhập lại.
- Tắt công tắc vẫn dùng được phiên hiện tại; lần mở sau phải đăng nhập lại. **Đăng xuất** xoá phiên đã giữ ngay.
- Đăng nhập canvasapp bằng Google: sau khi canvasapp xác nhận đăng nhập, SanoVids xoá cookie tài khoản Google khỏi app. Lần sau đăng nhập bằng Google trong SanoVids sẽ phải nhập lại mật khẩu Google.

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
- Ảnh chưa dùng, hoặc chỉ được nối mà prompt không nhắc tới, được xoá ngay (có Hoàn tác). Nếu xoá để lại chữ đỏ hoặc làm mất khung đầu/cuối, app hỏi trước.
- Đang lọc thì không xoá kèm thẻ bị ẩn. Sau khi xoá, không tự chọn thẻ kế tiếp để một lần Delete nữa xoá nhầm.
- Delete theo vùng bạn vừa dùng. Trên canvas, xoá thẻ ảnh chỉ ẩn thẻ; trong Thư viện mới xoá mục khỏi thư viện. Backspace trên Windows không dùng để xoá thẻ, tránh xung đột bộ gõ tiếng Việt.

🛠️ **Tập trung vào Canvas, Phát liền dễ tìm hơn**
- Ẩn **Bảng cảnh** và **Storyboard**, bỏ các phím chuyển sang hai màn này. **Phát liền** chuyển ra giữa thanh trên cùng.
- Dự án, cảnh, video và thứ tự cảnh giữ nguyên. Nếu lần trước bạn tắt app ở Bảng cảnh / Storyboard, app mở lại ở Canvas.
- Đổi thứ tự cảnh bằng ▲/▼, nhập vị trí ở mã cảnh trên bảng bên phải hoặc Alt+↑/↓. Mã cảnh, Phát liền và .zip đi theo thứ tự mới; thẻ trên canvas giữ vị trí.
- Dời cùng một cảnh nhiều lần nhanh liên tiếp được gom thành một lần Hoàn tác. Phát liền không tính chắc chắn thời lượng của take nhập khi chưa có đủ thông tin.

🛠️ **Bỏ video tham chiếu**
- Không còn nối video vào cảnh để làm `@video`. Ảnh tham chiếu và khung đầu/cuối theo model vẫn dùng được.
- Chữ `@video` cũ được giữ nguyên, tô đỏ và chặn chạy cảnh đó cho tới khi bạn sửa prompt. Sửa nhanh: nút **Xoá @video_1** dưới ô prompt ở bảng bên phải, hoặc chọn nhiều cảnh rồi **Xoá chữ @video ở N cảnh đang chọn** (có Hoàn tác). App không tự xoá chữ nào.
- **Cảnh từng nối video mà prompt không nhắc `@video` nay chạy được và chỉ gửi ảnh**, vẫn tính credit như thường. Lần đầu mở một dự án cũ trên máy này, thông báo cho biết số cảnh mỗi loại; bấm **Xem** để chọn các cảnh đó và kiểm tra trước khi chạy.
- Kéo một video đã tạo xong ra chỗ trống trên canvas → **Tạo cảnh tiếp theo từ video này**: cảnh mới cạnh video, cùng ảnh tham chiếu và cấu hình của video đó, prompt để trống. Video không được gửi kèm làm tham chiếu.
- Video kết quả của các cảnh còn trong dự án vẫn dùng để xem, chọn take và lưu.

🛠️ **Chế độ Phát triển chỉ dành cho nhà phát triển**
- Chế độ Phát triển (canvasapp giả lập) nay chỉ dành cho nhà phát triển.
- Video DEV tạo trước đây giữ nhãn DEV và vẫn xem được. Tạo video mới cần bật cổng canvasapp.io.vn (Cài đặt → Nhà cung cấp video) và xác nhận chi phí mỗi lần chạy; khi cổng chưa bật, bấm tạo video sẽ báo và có nút **Mở Cài đặt**.

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
- Giao diện và bộ biểu tượng được làm mới. Cài đặt → Giao diện có **Màu nền: Than / Đen sâu / Xám xanh**, mặc định **Than**.
- Màu nền chỉ áp dụng khi dùng giao diện Tối; giao diện Sáng có nền riêng. App nhớ lựa chọn, đưa vào xuất/nhập và khôi phục cài đặt.

🛠️ **Lưu file, mở dự án và dự án lớn**
- **Bỏ nối video khỏi Thư mục thì chuyển file vào Thùng rác** (Cài đặt → Tải video) **mặc định bật**, kể cả khi cập nhật từ bản cũ. Cắt dây video → Thư mục (mặc định, bấm một lần vào dây là cắt) sẽ chuyển vào Thùng rác file video và file .txt prompt mà chính dây đó đã lưu từ bản này và chưa bị sửa; file khác không bị đụng tới. Hoàn tác nối lại và ghi một bản mới; bản cũ vẫn trong Thùng rác. Không muốn thì tắt công tắc này.
- Dự án lớn (từ khoảng 800 thẻ, tức khoảng 300 cảnh) tự tạm ẩn bản đồ thu nhỏ và, khi hiện **Tất cả dây**, chỉ vẽ dây gần vùng đang xem. Hiện lại bản đồ bằng nút trên thanh công cụ; đổi ở Cài đặt → Dây nối & canvas → **Tối ưu khi dự án lớn**.
- Nhắc rõ khi chạy Portable hoặc bản sao trong thư mục tạm. Mở dự án có model/thông số của bản mới hơn thì giữ dữ liệu chưa hiểu và chặn chạy phần liên quan, tránh âm thầm thay cấu hình.
- Gõ prompt và hiển thị danh sách dài nhẹ hơn ở dự án nhiều cảnh. Sửa lỗi lưu/mở lại dự án sau khi xoá Thư mục cuối cùng.

⚠️ **Bản Mac thử nghiệm (khi bản thử có tính năng này)**
- Dành cho máy Mac **Apple Silicon**. Chưa có chữ ký Developer ID và xác nhận của Apple.
- Dùng ký hiệu phím và tên thao tác của Mac: ⌘, Finder, Keychain. Phím tải video là **⌘E** để ⌘M vẫn thu nhỏ cửa sổ.
- Nên đặt app trong Applications. Bản Mac **chỉ báo và mở trang tải bản mới, cập nhật bằng tay**. Nếu lần phát hành mới chỉ có bản Windows, app báo chưa có bản Mac mới hơn.

⚠️ **Lưu ý khi cập nhật**
- Mở dự án cũ, hãy xem chữ đỏ chờ ảnh, chữ `@video` cũ và các cảnh từng nối video trước khi xác nhận chi phí.
- Muốn giữ bản sao trước khi cập nhật: file **Xuất dự án** (Cài đặt → Dữ liệu dự án) chỉ chứa cảnh, prompt và ảnh, **không chứa video đã tạo**. Hãy tải các video cần giữ (Tải video, .zip hoặc Thư mục) trước.
- Nếu không rõ đã bị trừ credit hay có job trùng, dừng tạo video và kiểm tra lịch sử credit; huỷ hay lỗi không phải lúc nào cũng được hoàn credit.
