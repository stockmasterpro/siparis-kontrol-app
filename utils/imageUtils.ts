/**
 * Sıkıştırılmış Base64 görsel oluşturur.
 * Verilen görseli okur, maksimum belirtilen genişliğe orantılı olarak yeniden boyutlandırır
 * ve JPEG formatında (verilen kalite ile) sıkıştırarak Base64 string döndürür.
 * 
 * @param file Yüklenecek görsel dosyası (File nesnesi)
 * @param maxWidth İstenen maksimum genişlik (piksel)
 * @param quality JPEG kalite oranı (0 ile 1 arası, 0.7 önerilir)
 * @returns Base64 string (dataURL)
 */
export const compressImage = (file: File, maxWidth = 400, quality = 0.7): Promise<string> => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = (event) => {
            const img = new Image();
            img.src = event.target?.result as string;
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let width = img.width;
                let height = img.height;

                if (width > maxWidth) {
                    height = Math.round((height * maxWidth) / width);
                    width = maxWidth;
                }

                canvas.width = width;
                canvas.height = height;

                const ctx = canvas.getContext('2d');
                if (ctx) {
                    // Saydam alanları beyazla doldur (PNG'den JPEG'e çevrilirken arka plan siyah olmasın diye)
                    ctx.fillStyle = '#FFFFFF';
                    ctx.fillRect(0, 0, width, height);
                    ctx.drawImage(img, 0, 0, width, height);
                    const compressedBase64 = canvas.toDataURL('image/jpeg', quality);
                    resolve(compressedBase64);
                } else {
                    reject(new Error("Canvas context is not available"));
                }
            };
            img.onerror = (error) => reject(error);
        };
        reader.onerror = (error) => reject(error);
    });
};
