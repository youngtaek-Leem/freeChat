// Intersection Observer to trigger fade-in animations
document.addEventListener('DOMContentLoaded', () => {
    const observerOptions = {
        threshold: 0.1,
        rootMargin: '0px 0px -50px 0px'
    };

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('active');
                // Optional: stop observing once it has appeared
                // observer.unobserve(entry.target);
            }
        });
    }, observerOptions);

    // Fade in hero text
    document.querySelectorAll('.fade-in').forEach(el => {
        observer.observe(el);
    });

    // Fade in sections and cards
    const elementsToReveal = document.querySelectorAll('.intro, .ingredient-card, .tips-list li');
    elementsToReveal.forEach((el, index) => {
        el.classList.add('fade-in');
        // Add a bit of staggered delay for the grid cards
        if (el.classList.contains('ingredient-card')) {
            el.style.transitionDelay = `${(index % 3) * 0.1}s`;
        }
        observer.observe(el);
    });
});

// Subtle parallax effect on scroll for hero image
window.addEventListener('scroll', () => {
    const heroImg = document.querySelector('.hero-img');
    const scrollPos = window.pageYOffset;
    if (heroImg) {
        heroImg.style.transform = `translateY(${scrollPos * 0.3}px) scale(${1 + scrollPos * 0.0005})`;
    }
});
