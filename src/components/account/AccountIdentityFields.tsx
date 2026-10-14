import { Form, Input } from 'antd'

/** 注册与管理员创建共用；服务端还会独立验证，不能只依赖这些表单规则。 */
export default function AccountIdentityFields() {
  return <>
    <Form.Item name="username" label="用户名" rules={[{ required: true, pattern: /^[A-Za-z][A-Za-z0-9_-]{2,29}$/, message: '3–30位字母、数字、_或-，以字母开头' }]}>
      <Input maxLength={30} autoComplete="username" />
    </Form.Item>
    <Form.Item name="displayName" label="姓名" rules={[{ required: true, whitespace: true, message: '请输入姓名' }]}>
      <Input maxLength={50} />
    </Form.Item>
    <Form.Item name="email" label="邮箱" rules={[{ required: true, type: 'email', message: '请输入有效邮箱' }]}>
      <Input maxLength={254} autoComplete="email" />
    </Form.Item>
    <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }, { validator: (_, value: unknown) =>
      typeof value === 'string' && value.length >= 8 && value.trim() && new TextEncoder().encode(value).length <= 72
        ? Promise.resolve() : Promise.reject(new Error('密码至少8个字符，最多72个UTF-8字节')) }]}>
      <Input.Password maxLength={72} autoComplete="new-password" />
    </Form.Item>
    <Form.Item name="confirmPassword" label="确认密码" dependencies={['password']} rules={[{ required: true, message: '请再次输入密码' }, ({ getFieldValue }) => ({
      validator: (_, value) => value === getFieldValue('password') ? Promise.resolve() : Promise.reject(new Error('两次密码不一致')),
    })]}>
      <Input.Password maxLength={72} autoComplete="new-password" />
    </Form.Item>
  </>
}
