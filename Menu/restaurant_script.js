document.getElementById('download-btn').addEventListener('click', () => {
    const element = document.getElementById('menu-board');
    
    // Config for Traditional Korean Menu PDF
    const opt = {
        margin:       [0.5, 0.5],
        filename:     '가람_전통한식_메뉴판.pdf',
        image:        { type: 'jpeg', quality: 1.0 },
        html2canvas:  { 
            scale: 3, 
            useCORS: true,
            letterRendering: true,
            backgroundColor: '#fdfaf5' // Matches --bg-hanji
        },
        jsPDF:        { unit: 'in', format: 'a4', orientation: 'portrait' }
    };

    const btn = document.getElementById('download-btn');
    const originalText = btn.innerHTML;
    btn.innerHTML = '준비 중...';
    btn.disabled = true;

    html2pdf().set(opt).from(element).save().then(() => {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }).catch(err => {
        console.error('PDF 생성 오류:', err);
        btn.innerHTML = '발송 실패 (재시도)';
        btn.disabled = false;
    });
});

// Subtle reveal animation for sections
const observerOptions = {
    threshold: 0.05
};

const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.classList.add('reveal');
        }
    });
}, observerOptions);

document.querySelectorAll('.menu-section').forEach(section => {
    section.style.opacity = '0';
    section.style.transform = 'translateY(15px)';
    section.style.transition = 'all 0.8s ease-out';
    observer.observe(section);
});

// Add logic to toggle 'reveal' class
const style = document.createElement('style');
style.textContent = `
    .menu-section.reveal {
        opacity: 1 !important;
        transform: translateY(0) !important;
    }
`;
document.head.appendChild(style);
