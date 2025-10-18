# Product Claims Management API Documentation

## Overview
ระบบจัดการการเคลมสินค้าที่ให้ลูกค้าสามารถยื่นเคลมสินค้าที่ซื้อไป และแอดมินสามารถจัดการเคลมได้ครบถ้วน

## Database Schema
ตาราง `product_claims` มีโครงสร้างดังนี้:
- `id`: Primary key
- `customer_id`: สำหรับ multi-tenant
- `user_id`: ลูกค้าที่ยื่นเคลม
- `transaction_id`: transaction ที่เกี่ยวข้อง
- `product_id`: สินค้าที่เคลม
- `product_price`: ราคาสินค้า ณ เวลาซื้อ
- `claim_reason`: สาเหตุหรือรายละเอียดการเคลมจากลูกค้า
- `admin_note`: ข้อความจากแอดมิน
- `status`: สถานะการเคลม (pending, approved, rejected, refunded)
- `created_at`, `updated_at`: เวลาสร้างและอัปเดต

## API Endpoints

### 1. สร้างการเคลมใหม่
**POST** `/api/product-claims`

**Headers:**
```
Authorization: Bearer <token>
```

**Body:**
```json
{
  "transaction_id": 123,
  "product_id": 456,
  "claim_reason": "สินค้าไม่ทำงานตามที่ระบุ"
}
```

**Response:**
```json
{
  "message": "Claim created successfully",
  "claim_id": 789
}
```

### 2. ดึงรายการการเคลมทั้งหมด (Admin เท่านั้น)
**GET** `/api/product-claims`

**Headers:**
```
Authorization: Bearer <admin_token>
```

**Response:**
```json
[
  {
    "id": 1,
    "customer_id": "death",
    "user_id": 123,
    "transaction_id": 456,
    "product_id": 789,
    "product_price": 100.00,
    "claim_reason": "สินค้าไม่ทำงาน",
    "admin_note": null,
    "status": "pending",
    "created_at": "2024-01-01T00:00:00.000Z",
    "updated_at": "2024-01-01T00:00:00.000Z",
    "user_name": "John Doe",
    "user_email": "john@example.com",
    "product_title": "Premium Software",
    "bill_number": "BILL-001"
  }
]
```

### 3. ดึงการเคลมตาม ID
**GET** `/api/product-claims/:id`

**Headers:**
```
Authorization: Bearer <token>
```

**Response:**
```json
{
  "id": 1,
  "customer_id": "death",
  "user_id": 123,
  "transaction_id": 456,
  "product_id": 789,
  "product_price": 100.00,
  "claim_reason": "สินค้าไม่ทำงาน",
  "admin_note": "กำลังตรวจสอบ",
  "status": "pending",
  "created_at": "2024-01-01T00:00:00.000Z",
  "updated_at": "2024-01-01T00:00:00.000Z",
  "user_name": "John Doe",
  "user_email": "john@example.com",
  "product_title": "Premium Software",
  "bill_number": "BILL-001"
}
```

### 4. อัปเดตสถานะการเคลม (Admin เท่านั้น)
**PUT** `/api/product-claims/:id/status`

**Headers:**
```
Authorization: Bearer <admin_token>
```

**Body:**
```json
{
  "status": "approved"
}
```

**Status Options:**
- `pending`: รอการตรวจสอบ
- `approved`: อนุมัติแล้ว
- `rejected`: ปฏิเสธ
- `refunded`: คืนเงินแล้ว

**Response:**
```json
{
  "message": "Status updated successfully"
}
```

### 5. เพิ่ม Admin Note (Admin เท่านั้น)
**PUT** `/api/product-claims/:id/note`

**Headers:**
```
Authorization: Bearer <admin_token>
```

**Body:**
```json
{
  "admin_note": "ตรวจสอบแล้ว พบว่าสินค้ามีปัญหา อนุมัติการคืนเงิน"
}
```

**Response:**
```json
{
  "message": "Note updated successfully"
}
```

### 6. คืนเงินให้ลูกค้า (Admin เท่านั้น)
**POST** `/api/product-claims/:id/refund`

**Headers:**
```
Authorization: Bearer <admin_token>
```

**Note:** การเคลมต้องมี status เป็น "approved" เท่านั้น

**Response:**
```json
{
  "message": "Refund processed successfully",
  "refund_amount": 100.00
}
```

### 7. ลบการเคลม (Admin เท่านั้น)
**DELETE** `/api/product-claims/:id`

**Headers:**
```
Authorization: Bearer <admin_token>
```

**Response:**
```json
{
  "message": "Claim deleted successfully"
}
```

### 8. ดึงการเคลมของตัวเอง
**GET** `/api/user/product-claims`

**Headers:**
```
Authorization: Bearer <token>
```

**Response:**
```json
[
  {
    "id": 1,
    "customer_id": "death",
    "user_id": 123,
    "transaction_id": 456,
    "product_id": 789,
    "product_price": 100.00,
    "claim_reason": "สินค้าไม่ทำงาน",
    "admin_note": "กำลังตรวจสอบ",
    "status": "pending",
    "created_at": "2024-01-01T00:00:00.000Z",
    "updated_at": "2024-01-01T00:00:00.000Z",
    "product_title": "Premium Software",
    "bill_number": "BILL-001"
  }
]
```

### 9. ดึงรายการ Transaction ที่สามารถเคลมได้
**GET** `/api/user/transactions-for-claim`

**Headers:**
```
Authorization: Bearer <token>
```

**Response:**
```json
[
  {
    "id": 123,
    "bill_number": "BILL-001",
    "total_price": 500.00,
    "created_at": "2024-01-01T00:00:00.000Z",
    "products": [
      {
        "product_id": 456,
        "title": "Premium Software",
        "price": 100.00,
        "quantity": 1
      },
      {
        "product_id": 789,
        "title": "Basic Software",
        "price": 50.00,
        "quantity": 2
      }
    ]
  }
]
```

## Error Responses

### 400 Bad Request
```json
{
  "error": "Missing required fields"
}
```

### 403 Forbidden
```json
{
  "error": "Access denied"
}
```

### 404 Not Found
```json
{
  "error": "Claim not found"
}
```

### 500 Internal Server Error
```json
{
  "error": "Internal server error"
}
```

## Usage Examples

### ตัวอย่างการใช้งานใน Frontend

#### 1. สร้างการเคลมใหม่
```javascript
const createClaim = async (transactionId, productId, reason) => {
  const response = await fetch('/api/product-claims', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      transaction_id: transactionId,
      product_id: productId,
      claim_reason: reason
    })
  });
  
  return await response.json();
};
```

#### 2. อัปเดตสถานะการเคลม (Admin)
```javascript
const updateClaimStatus = async (claimId, status) => {
  const response = await fetch(`/api/product-claims/${claimId}/status`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${adminToken}`
    },
    body: JSON.stringify({ status })
  });
  
  return await response.json();
};
```

#### 3. คืนเงินให้ลูกค้า (Admin)
```javascript
const processRefund = async (claimId) => {
  const response = await fetch(`/api/product-claims/${claimId}/refund`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${adminToken}`
    }
  });
  
  return await response.json();
};
```

## Security Features

1. **Authentication Required**: ทุก endpoint ต้องมี JWT token
2. **Role-based Access**: Admin-only endpoints ตรวจสอบ role
3. **Multi-tenant Support**: แยกข้อมูลตาม customer_id
4. **Data Validation**: ตรวจสอบข้อมูลก่อนประมวลผล
5. **Transaction Safety**: ใช้ database transaction สำหรับการคืนเงิน

## Database Migration

หากต้องการอัปเดตตารางที่มีอยู่แล้ว ให้รันคำสั่ง SQL นี้:

```sql
ALTER TABLE product_claims 
MODIFY COLUMN status enum('pending','approved','rejected','refunded') NOT NULL DEFAULT 'pending';
```
