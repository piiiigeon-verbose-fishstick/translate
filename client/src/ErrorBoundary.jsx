import { Component } from 'react'

class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          maxWidth: 600,
          margin: '100px auto',
          padding: 30,
          background: 'white',
          borderRadius: 16,
          boxShadow: '0 10px 40px rgba(0,0,0,0.1)',
          textAlign: 'center'
        }}>
          <h2 style={{ color: '#c62828', marginBottom: 15 }}>应用发生错误</h2>
          <p style={{ color: '#666', marginBottom: 20 }}>
            {this.state.error?.message || '未知错误'}
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '10px 30px',
              background: 'linear-gradient(135deg, #4f46e5 0%, #6366f1 100%)',
              color: 'white',
              border: 'none',
              borderRadius: 30,
              cursor: 'pointer',
              fontSize: '1rem'
            }}
          >
            刷新页面
          </button>
        </div>
      )
    }

    return this.props.children
  }
}

export default ErrorBoundary
