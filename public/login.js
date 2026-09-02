const params = new URLSearchParams(window.location.search);
const error = params.get('error');
const message = document.querySelector('#login-error');

if (error && message) {
    message.hidden = false;
    message.textContent = error === 'rate'
        ? 'محاولات كثيرة. انتظر 15 دقيقة ثم حاول من جديد.'
        : 'كلمة المرور غير صحيحة.';
}
