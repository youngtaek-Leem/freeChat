function updateClock() {
    const now = new Date();
    
    // Time components
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    
    // Date components
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const day = now.getDate();
    const weekDays = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];
    const weekDay = weekDays[now.getDay()];
    
    // Update DOM
    document.getElementById('hours').textContent = h;
    document.getElementById('minutes').textContent = m;
    document.getElementById('seconds').textContent = s;
    document.getElementById('date-display').textContent = `${year}년 ${month}월 ${day}일 ${weekDay}`;
    
    // Dynamic greeting based on time
    const greetingText = document.getElementById('greeting-text');
    const hour = now.getHours();
    
    if (hour >= 5 && hour < 12) {
        greetingText.textContent = "상쾌한 아침입니다!";
    } else if (hour >= 12 && hour < 18) {
        greetingText.textContent = "활기찬 오후입니다!";
    } else if (hour >= 18 && hour < 22) {
        greetingText.textContent = "편안한 저녁 되세요.";
    } else {
        greetingText.textContent = "고요한 밤입니다.";
    }
}

// Initial call
updateClock();

// Update every second
setInterval(updateClock, 1000);

// Add subtle mouse move effect to the card
const card = document.getElementById('clock-card');
document.addEventListener('mousemove', (e) => {
    const x = (window.innerWidth / 2 - e.pageX) / 25;
    const y = (window.innerHeight / 2 - e.pageY) / 25;
    card.style.transform = `rotateY(${x}deg) rotateX(${y}deg)`;
});
