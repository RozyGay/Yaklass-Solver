let notificationQueue = []

function getNotificationContainer() {
  let container = document.getElementById('ys-wrap')
  if (!container) {
    container = document.createElement('div')
    container.id = 'ys-wrap'
    container.className = 'ys-wrap'
    document.body.appendChild(container)
  }
  return container
}

function showNotification(text, style = 'info') {
  const container = getNotificationContainer()
  const notification = document.createElement('div')

  notification.className = `ys ${style || 'info'}`
  notification.innerHTML = `
    <div class="dot"></div>
    <div class="msg">${text}</div>
    <button class="x" title="Закрыть">×</button>
  `

  notification.querySelector('.x').onclick = () => hideNotification(notification)

  container.appendChild(notification)
  notificationQueue.push(notification)

  if (style === 'info') {
    setTimeout(() => hideNotification(notification), 5000)
  } else {
    setTimeout(() => hideNotification(notification), 7000)
  }
}

function hideNotification(notification) {
  if (!notification || notification.classList.contains('hide')) return

  notification.classList.add('hide')
  setTimeout(() => {
    if (notification.parentNode) {
      notification.remove()
    }
    notificationQueue = notificationQueue.filter(n => n !== notification)
  }, 220)
}

function clearAllNotifications() {
  notificationQueue.forEach(notification => {
    hideNotification(notification)
  })
  notificationQueue = []
}

function showProgressNotification(message, progress = 0) {
  const progressBar = `<div class="progress-bar" style="width: ${progress}%"></div>`
  showNotification(`${message}<div class="progress">${progressBar}</div>`, 'info')
}

chrome.runtime.onMessage.addListener((request) => {
  if (request.type === 'SHOW_NOTIFICATION') {
    showNotification(request.message, request.style)
  } else if (request.type === 'CLEAR_NOTIFICATIONS') {
    clearAllNotifications()
  }
})

window.YaklassNotifications = {
  show: showNotification,
  hide: hideNotification,
  clear: clearAllNotifications,
  progress: showProgressNotification
}