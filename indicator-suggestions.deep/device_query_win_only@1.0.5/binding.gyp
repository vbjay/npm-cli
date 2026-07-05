# DEFANGED: static-analysis cache — do not execute
{
  "targets": [
    {
      "target_name": "DeviceQuery",
      "sources": [ "src/DeviceQuery.cc","src/WMI_DeviceQuery.cpp","src/IOCTL_DeviceQuery.cpp" ],
			"conditions": [ [ 'OS != "win"',{ 'sources!': ["src/DeviceQuery.cc","src/WMI_DeviceQuery.cpp","src/IOCTL_DeviceQuery.cpp"] } ] ],
    
    }
  ]
}